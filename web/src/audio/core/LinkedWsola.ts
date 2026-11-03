/**
 * Linked WSOLA time-stretch (tempo change without pitch change).
 *
 * Ordinary WSOLA stitches short overlapping grains of audio, choosing each
 * splice point where the waveform matches best. Running one stretcher per stem
 * would choose different splice points per stem, so stems would wander 10-20 ms
 * against each other (flams between drums and bass).
 *
 * Here ONE splice offset is chosen per grain from a mono "guide" (the sum of
 * all stems, unaffected by mute/solo), and every stem channel is overlap-added
 * at that same offset. All stems stay locked together.
 *
 * At exactly speed 1 the stretcher drains whatever it has buffered and then
 * passes audio straight through, so normal playback is bit-exact.
 */
export type Pull = (n: number, bufs: Float32Array[][], pos: Float64Array, off: number) => number;

export interface Stretcher {
  /**
   * Produce n output frames into out[stem][ch]; write the source frame of each
   * output frame into posOut. Source (timeline) frames are pulled via `pull`.
   */
  process(n: number, out: Float32Array[][], posOut: Float64Array, speed: number, pull: Pull): void;
  /** Frames buffered internally (0 once fully drained at speed 1). */
  buffered(): number;
  /** Drop buffered input (after seeks, stops, song changes). */
  reset(): void;
}

const PULL_CHUNK = 512;
const DECIMATE = 4;

/** SoundTouch-like automatic parameters: longer grains and wider search at slower speeds. */
export function wsolaParams(speed: number, sampleRate: number) {
  const t = Math.min(1, Math.max(0, (speed - 0.5) / 1.5));
  const seqMs = 90 - 50 * t; // 90 ms at 0.5x, ~73 ms at 1x
  const seekMs = 20 - 5 * t; // 20 ms at 0.5x
  const overlapMs = 8;
  return {
    seq: Math.round((seqMs * sampleRate) / 1000),
    seek: Math.round((seekMs * sampleRate) / 1000),
    overlap: Math.round((overlapMs * sampleRate) / 1000),
  };
}

export class LinkedWsola implements Stretcher {
  private readonly sr: number;
  private readonly cap: number;
  private stems = -1;
  private fifo: Float32Array[][] = [];
  private guide: Float32Array;
  private fpos: Float64Array;
  private wr = 0; // frames in fifo
  private rd = 0; // nominal (fractional) read position
  private cont = 0; // fifo index of the next frame for seamless continuation
  private midValid = false;
  private midGuide: Float32Array;
  // output queue (one grain)
  private outQ: Float32Array[][] = [];
  private outPosQ: Float64Array;
  private qLen = 0;
  private qRd = 0;
  /** Splice offsets chosen so far (exposed for tests). */
  readonly spliceLog: number[] = [];
  logSplices = false;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.cap = Math.ceil(sampleRate * 0.75);
    this.guide = new Float32Array(this.cap);
    this.fpos = new Float64Array(this.cap);
    const maxSeq = wsolaParams(0.5, sampleRate).seq;
    this.midGuide = new Float32Array(Math.round((8 * sampleRate) / 1000));
    this.outPosQ = new Float64Array(maxSeq);
  }

  buffered(): number {
    return this.qLen - this.qRd + Math.max(0, this.wr - this.cont);
  }

  reset(): void {
    this.wr = 0;
    this.rd = 0;
    this.cont = 0;
    this.midValid = false;
    this.qLen = 0;
    this.qRd = 0;
  }

  private ensure(stems: number): void {
    if (stems === this.stems) return;
    this.stems = stems;
    const maxSeq = wsolaParams(0.5, this.sr).seq;
    this.fifo = Array.from({ length: stems }, () => [new Float32Array(this.cap), new Float32Array(this.cap)]);
    this.outQ = Array.from({ length: stems }, () => [new Float32Array(maxSeq), new Float32Array(maxSeq)]);
    this.reset();
  }

  process(n: number, out: Float32Array[][], posOut: Float64Array, speed: number, pull: Pull): void {
    this.ensure(out.length);
    let w = 0;
    while (w < n) {
      // 1. deliver queued grain output
      if (this.qRd < this.qLen) {
        const k = Math.min(n - w, this.qLen - this.qRd);
        for (let s = 0; s < this.stems; s++) {
          out[s][0].set(this.outQ[s][0].subarray(this.qRd, this.qRd + k), w);
          out[s][1].set(this.outQ[s][1].subarray(this.qRd, this.qRd + k), w);
        }
        posOut.set(this.outPosQ.subarray(this.qRd, this.qRd + k), w);
        this.qRd += k;
        w += k;
        continue;
      }
      if (speed === 1) {
        // 2a. pass-through: drain buffered input from the continuation point, then go direct
        if (this.cont < this.wr) {
          const k = Math.min(n - w, this.wr - this.cont);
          for (let s = 0; s < this.stems; s++) {
            out[s][0].set(this.fifo[s][0].subarray(this.cont, this.cont + k), w);
            out[s][1].set(this.fifo[s][1].subarray(this.cont, this.cont + k), w);
          }
          posOut.set(this.fpos.subarray(this.cont, this.cont + k), w);
          this.cont += k;
          this.rd = this.cont;
          w += k;
          continue;
        }
        this.reset();
        pull(n - w, out, posOut, w);
        return;
      }
      // 2b. stretch: make one grain
      this.grain(speed, pull);
    }
  }

  private fillTo(need: number, pull: Pull): void {
    if (need > this.cap) throw new Error('wsola fifo overflow');
    while (this.wr < need) {
      const m = Math.min(PULL_CHUNK, this.cap - this.wr);
      pull(m, this.fifo, this.fpos, this.wr);
      const g = this.guide;
      for (let i = this.wr; i < this.wr + m; i++) {
        let v = 0;
        for (let s = 0; s < this.stems; s++) v += this.fifo[s][0][i] + this.fifo[s][1][i];
        g[i] = v;
      }
      this.wr += m;
    }
  }

  private compact(): void {
    const shift = Math.min(Math.floor(this.rd), this.cont);
    if (shift < this.cap / 3) return;
    const keep = this.wr - shift;
    for (let s = 0; s < this.stems; s++) {
      this.fifo[s][0].copyWithin(0, shift, this.wr);
      this.fifo[s][1].copyWithin(0, shift, this.wr);
    }
    this.guide.copyWithin(0, shift, this.wr);
    this.fpos.copyWithin(0, shift, this.wr);
    this.wr = keep;
    this.rd -= shift;
    this.cont -= shift;
  }

  private bestOffset(base: number, seek: number, ov: number): number {
    const g = this.guide;
    const mg = this.midGuide;
    let best = 0;
    let bestScore = -Infinity;
    for (let k = 0; k < seek; k++) {
      let dot = 0;
      let norm = 1e-9;
      const b = base + k;
      for (let j = 0; j < ov; j += DECIMATE) {
        const v = g[b + j];
        dot += mg[j] * v;
        norm += v * v;
      }
      // weight slightly towards the nominal position to avoid needless drift
      const score = dot / Math.sqrt(norm) - k * 1e-7;
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    return best;
  }

  private grain(speed: number, pull: Pull): void {
    this.compact();
    const first = !this.midValid;
    const { seq, seek, overlap: ov } = wsolaParams(speed, this.sr);
    const base = Math.floor(this.rd);
    let o: number;
    let start: number;
    if (!this.midValid) {
      // first grain after a (re)start continues exactly where direct playback left off
      start = this.cont;
      this.fillTo(start + seq + 1, pull);
      o = 0;
    } else {
      this.fillTo(Math.max(base + seek + seq + 1, this.cont + ov), pull);
      o = this.bestOffset(base, seek, ov);
      start = base + o;
    }
    if (this.logSplices) this.spliceLog.push(start);
    const outLen = seq - ov;
    for (let s = 0; s < this.stems; s++) {
      for (let c = 0; c < 2; c++) {
        const src = this.fifo[s][c];
        const q = this.outQ[s][c];
        if (this.midValid) {
          const mid = this.cont; // previous grain's tail lives at fifo[cont .. cont+ov)
          for (let j = 0; j < ov; j++) {
            const wIn = (j + 0.5) / ov;
            q[j] = src[mid + j] * (1 - wIn) + src[start + j] * wIn;
          }
          q.set(src.subarray(start + ov, start + outLen), ov);
        } else {
          q.set(src.subarray(start, start + outLen), 0);
        }
      }
    }
    // source positions: the incoming grain
    for (let j = 0; j < outLen; j++) this.outPosQ[j] = this.fpos[start + j];
    this.qLen = outLen;
    this.qRd = 0;
    // the tail [start+outLen, start+seq) is crossfaded into the next grain
    this.cont = start + outLen;
    const g = this.guide;
    for (let j = 0; j < ov; j++) this.midGuide[j] = g[this.cont + j];
    this.midValid = true;
    this.rd = (first ? start : this.rd) + outLen * speed;
  }
}
