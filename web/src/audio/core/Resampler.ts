/**
 * Linked resampler for key changes.
 *
 * Transposing by r = 2^(semitones/12) without changing the tempo is done in
 * two steps: the time-stretcher makes the music r times longer (speed / r),
 * then this resampler plays that back r times faster. Tempo comes back to
 * `speed`; pitch moves by r.
 *
 * Like the stretcher, it is linked: every stem channel is read at the same
 * fractional position with the same weights, so stems cannot drift apart.
 * Interpolation is 4-point cubic Hermite.
 */

/** Fill `n` frames into out[stem][ch] and posOut, starting at index 0. */
export type PullFromZero = (n: number, out: Float32Array[][], posOut: Float64Array) => void;

const CHUNK = 256;

function hermite(xm1: number, x0: number, x1: number, x2: number, t: number): number {
  const c = (x1 - xm1) * 0.5;
  const v = x0 - x1;
  const w = c + v;
  const a = w + v + (x2 - x0) * 0.5;
  const b = w + a;
  return ((a * t - b) * t + c) * t + x0;
}

export class LinkedResampler {
  private stems = -1;
  private cap = 0;
  private buf: Float32Array[][] = [];
  private bpos = new Float64Array(0);
  /** Frames held in buf (index 0 is one frame of history before `phase` can start). */
  private len = 0;
  /** Read position in buf (fractional). */
  private phase = 1;
  private scratch: Float32Array[][] = [];
  private scratchPos = new Float64Array(CHUNK);
  private k = new Int32Array(0);
  private t = new Float32Array(0);

  /** Input frames buffered but not yet played. */
  buffered(): number {
    return Math.max(0, this.len - this.phase);
  }

  reset(): void {
    this.len = 0;
    this.phase = 1;
  }

  private ensure(stems: number, need: number, n: number): void {
    if (stems !== this.stems) {
      this.stems = stems;
      this.cap = 0;
      this.scratch = Array.from({ length: stems }, () => [new Float32Array(CHUNK), new Float32Array(CHUNK)]);
      this.reset();
    }
    if (need > this.cap) {
      const cap = Math.max(need, 2 * this.cap, 4096);
      const nb = Array.from({ length: stems }, (_, s) =>
        [0, 1].map((c) => {
          const a = new Float32Array(cap);
          if (this.buf[s]) a.set(this.buf[s][c].subarray(0, this.len));
          return a;
        }),
      );
      const np = new Float64Array(cap);
      np.set(this.bpos.subarray(0, this.len));
      this.buf = nb;
      this.bpos = np;
      this.cap = cap;
    }
    if (this.k.length < n) {
      this.k = new Int32Array(n);
      this.t = new Float32Array(n);
    }
  }

  /** Drop frames that are no longer needed (keep one frame of history). */
  private compact(): void {
    const drop = Math.floor(this.phase) - 1;
    if (drop < 1024) return;
    for (let s = 0; s < this.stems; s++) {
      this.buf[s][0].copyWithin(0, drop, this.len);
      this.buf[s][1].copyWithin(0, drop, this.len);
    }
    this.bpos.copyWithin(0, drop, this.len);
    this.len -= drop;
    this.phase -= drop;
  }

  process(n: number, out: Float32Array[][], posOut: Float64Array, ratio: number, pull: PullFromZero): void {
    const stems = out.length;
    this.ensure(stems, 0, n);
    this.compact();
    // input needed: up to the last output's position plus two frames of look-ahead
    const need = Math.floor(this.phase + (n - 1) * ratio) + 3;
    this.ensure(stems, need + CHUNK, n);
    if (this.len === 0) {
      // start: one frame of (silent) history before the first real frame
      for (let s = 0; s < stems; s++) {
        this.buf[s][0][0] = 0;
        this.buf[s][1][0] = 0;
      }
      this.len = 1;
      this.phase = 1;
    }
    while (this.len < need) {
      const m = Math.min(CHUNK, this.cap - this.len);
      pull(m, this.scratch, this.scratchPos);
      for (let s = 0; s < stems; s++) {
        this.buf[s][0].set(this.scratch[s][0].subarray(0, m), this.len);
        this.buf[s][1].set(this.scratch[s][1].subarray(0, m), this.len);
      }
      this.bpos.set(this.scratchPos.subarray(0, m), this.len);
      if (this.len === 1) this.bpos[0] = this.bpos[1] - 1;
      this.len += m;
    }
    const K = this.k;
    const T = this.t;
    let x = this.phase;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(x);
      K[i] = k;
      T[i] = x - k;
      const p0 = this.bpos[k];
      const p1 = this.bpos[k + 1];
      // across a jump the positions are not continuous: report the frame itself
      posOut[i] = Math.abs(p1 - p0) <= 2 ? p0 + (p1 - p0) * T[i] : p0;
      x += ratio;
    }
    this.phase = x;
    for (let s = 0; s < stems; s++) {
      for (let c = 0; c < 2; c++) {
        const src = this.buf[s][c];
        const dst = out[s][c];
        for (let i = 0; i < n; i++) {
          const k = K[i];
          dst[i] = hermite(src[k - 1], src[k], src[k + 1], src[k + 2], T[i]);
        }
      }
    }
  }
}
