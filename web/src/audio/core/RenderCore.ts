import { readRun } from './StemBlocks';
import { lowerBound, nextDownbeat, segmentAt } from './grid';
import {
  RAMP_FRAMES,
  SAMPLE_RATE,
  XFADE_FRAMES,
  stereoRouting,
  type CoreEvent,
  type CorePosition,
  type Frame,
  type Grid,
  type Program,
  type Quantize,
  type Routing,
  type SongPcm,
  type StemParams,
} from './types';
import type { Stretcher } from './LinkedWsola';

/**
 * The whole playback engine, with no DOM or Web Audio dependency.
 *
 * Every stem is read from ONE integer source position, so stems cannot drift.
 * The AudioWorklet wraps this class, the export worker reuses it, and tests
 * drive it directly.
 *
 * Pipeline per render() call:
 *   fill()    -> the "timeline stream": source frames for every stem, following
 *                the Program (segments, loops, queued jumps) with equal-power
 *                crossfades at every discontinuity.
 *   stretch   -> optional linked WSOLA (same splice points for all stems).
 *   mix       -> per-stem gain/pan/mute/solo ramps, routed to output channels
 *                (stereo pairs or single channels), click, play/pause ramp.
 */

type State = 'stopped' | 'playing' | 'stopping' | 'countIn';
type TriggerKind = 'none' | 'pending' | 'contig' | 'xfade' | 'end';

interface Xfade {
  outPos: Frame;
  i: number;
  len: number;
  toSilence: boolean;
}

interface Pending {
  to: number;
  q: Quantize;
  at: Frame;
  start: Frame;
  len: number;
}

export interface ClickParams {
  enabled: boolean;
  gain: number;
}

const STEREO_DEST = [{ l: 0, r: 1 }];

/** Max backward/forward move of the source position that is a stretcher splice, not a jump. */
const SPLICE_TOLERANCE = 6000;

const DEFAULT_PARAMS: StemParams = { gain: 1, pan: 0, mute: false, solo: false };
const HALF_PI = Math.PI / 2;

function makeClick(freq: number, sampleRate: number, ms = 25): Float32Array {
  const n = Math.round((ms / 1000) * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / 0.006) * Math.min(1, i / 24);
    out[i] = Math.sin(2 * Math.PI * freq * t) * env;
  }
  return out;
}

export class RenderCore {
  readonly sampleRate: number;
  onEvent: ((e: CoreEvent) => void) | null = null;

  private song: SongPcm | null = null;
  private beats: Frame[] = [];
  private downbeats: Frame[] = [];
  private isDownbeat = new Uint8Array(0);
  private program: Program = { segments: [], loop: false };
  private seg = 0;
  private pos: Frame = 0;
  private state: State = 'stopped';
  private master = 0;
  private xf: Xfade | null = null;
  private pending: Pending | null = null;
  private trigger: Frame = Infinity;
  private triggerKind: TriggerKind = 'none';

  private params: StemParams[] = [];
  // current (ramping) gains; Float64 so they settle exactly on the target
  private gl = new Float64Array(0);
  private gr = new Float64Array(0);

  private cap = 0;
  private stemBuf: Float32Array[][] = [];
  private tmpL = new Float32Array(0);
  private tmpR = new Float32Array(0);
  private srcPos = new Float64Array(0);

  private stretcher: Stretcher | null = null;
  private speed = 1;
  /** Crossfade length for jumps and arrangement joins (frames); XFADE_FRAMES = a clean cut. */
  private transition = XFADE_FRAMES;
  /** Live "Repeat" (vamp): the current segment loops until a queued jump lands. */
  private repeat = false;
  private stretching = false;
  /** Source frame of the last output frame (differs from pos while the stretcher buffers). */
  private lastOut = 0;
  private readonly pull = (m: number, bufs: Float32Array[][], pos: Float64Array, off: number) =>
    this.fill(m, bufs, pos, off);

  private click: ClickParams = { enabled: false, gain: 0.7 };
  /** Master level for the whole song (all tracks; not the app's click). */
  private masterGain = 1;
  // song meter: peak of the summed tracks (L/R) since the last takeMeter(), and clipping on any output
  private busL = new Float32Array(0);
  private busR = new Float32Array(0);
  private meterL = 0;
  private meterR = 0;
  private clipped = false;
  private routing: Routing = stereoRouting(0);
  // test tone (to find a channel on the desk); plays even when stopped
  private toneCh = -1;
  private toneLeft = 0;
  private tonePhase = 0;
  private clickHi: Float32Array;
  private clickLo: Float32Array;
  private clickBuf: Float32Array | null = null;
  private clickIdx = 0;
  private nextBeat = 0;
  private lastSrc = -2;

  private countInLeft = 0;
  private countInBeats: number[] = [];
  private countInBeatIdx = 0;
  private countInLen = 0;

  constructor(sampleRate = SAMPLE_RATE) {
    this.sampleRate = sampleRate;
    this.clickHi = makeClick(2000, sampleRate);
    this.clickLo = makeClick(1300, sampleRate);
    this.ensureCapacity(1024);
  }

  // ---------------------------------------------------------------- setup

  setSong(song: SongPcm | null, grid: Grid = { beats: [], downbeats: [] }): void {
    this.song = song;
    this.state = 'stopped';
    this.master = 0;
    this.xf = null;
    this.pending = null;
    this.pos = 0;
    this.seg = 0;
    const n = song ? song.stems.length : 0;
    this.params = Array.from({ length: n }, () => ({ ...DEFAULT_PARAMS }));
    this.gl = new Float64Array(n);
    this.gr = new Float64Array(n);
    this.routing = stereoRouting(n);
    this.cap = 0;
    this.ensureCapacity(1024);
    this.setGrid(grid);
    this.program = song
      ? { segments: [{ id: 'all', start: 0, end: song.length }], loop: false }
      : { segments: [], loop: false };
    this.repeat = false;
    this.stretcher?.reset();
    this.computeTrigger();
  }

  setGrid(grid: Grid): void {
    this.beats = grid.beats.slice();
    this.downbeats = grid.downbeats.slice();
    const db = new Set(this.downbeats);
    this.isDownbeat = new Uint8Array(this.beats.length);
    this.beats.forEach((b, i) => (this.isDownbeat[i] = db.has(b) ? 1 : 0));
    this.nextBeat = lowerBound(this.beats, this.pos);
  }

  setStretcher(stretcher: Stretcher | null): void {
    this.stretcher = stretcher;
    stretcher?.reset();
  }

  setSpeed(speed: number): void {
    const s = Math.min(1, Math.max(0.5, speed));
    if (s === this.speed) return;
    this.speed = s;
    this.stretcher?.reset();
  }

  getSpeed(): number {
    return this.speed;
  }

  /**
   * How long jumps between parts fade (frames). The fade always ends on the
   * target downbeat at full level, so it starts this long before the boundary.
   * Loops keep a short crossfade so they stay tight.
   */
  setTransition(frames: number): void {
    const f = Math.max(XFADE_FRAMES, Math.min(8 * this.sampleRate, Math.round(frames)));
    if (f === this.transition) return;
    this.transition = f;
    const p = this.pending;
    if (p && this.isRunning()) this.queueJump(p.to, p.q); // re-time the queued jump
    else this.computeTrigger();
  }

  getTransition(): number {
    return this.transition;
  }

  /**
   * Repeat (vamp): at its end the current segment starts again (tight crossfade)
   * instead of moving on. A queued jump still lands, and turns repeat off.
   */
  setRepeat(on: boolean): void {
    if (on === this.repeat) return;
    this.repeat = on;
    this.computeTrigger();
  }

  getRepeat(): boolean {
    return this.repeat;
  }

  setStem(index: number, p: Partial<StemParams>): void {
    if (index < 0 || index >= this.params.length) return;
    this.params[index] = { ...this.params[index], ...p };
  }

  setClick(p: Partial<ClickParams>): void {
    this.click = { ...this.click, ...p };
  }

  /** Master level for the whole song (linear, up to +6 dB). Applies to every track on every output. */
  setMasterGain(g: number): void {
    this.masterGain = Math.max(0, Math.min(1.9953, g));
  }

  getMasterGain(): number {
    return this.masterGain;
  }

  /**
   * The song's level since the last call: peak of all tracks summed (L/R, after
   * their faders and the master), and whether any output went over 0 dBFS. Resets.
   */
  takeMeter(): { l: number; r: number; clip: boolean } {
    const m = { l: this.meterL, r: this.meterR, clip: this.clipped };
    this.meterL = 0;
    this.meterR = 0;
    this.clipped = false;
    return m;
  }

  /** Where each stem and the click go. Channels outside the rendered outputs are ignored. */
  setRouting(r: Routing): void {
    this.routing = { stems: r.stems.map((d) => d.slice()), click: r.click.slice() };
  }

  getRouting(): Routing {
    return this.routing;
  }

  /** A short 1 kHz beep on one output channel (0-based), even when stopped. */
  testTone(channel: number, seconds = 0.6): void {
    this.toneCh = channel;
    this.toneLeft = Math.round(seconds * this.sampleRate);
    this.tonePhase = 0;
  }

  /**
   * Replace the program. If the current position lies inside one of the new
   * segments, playback continues seamlessly; otherwise it moves to the first segment.
   */
  setProgram(p: Program): void {
    this.program = { segments: p.segments.map((s) => ({ ...s })), loop: p.loop };
    this.pending = null;
    const segs = this.program.segments;
    if (segs.length === 0 || !this.song) {
      this.state = 'stopped';
      this.master = 0;
      this.computeTrigger();
      return;
    }
    const idx = segmentAt(segs, this.pos);
    const inside = this.pos >= segs[idx].start && this.pos < segs[idx].end;
    if (inside) {
      this.seg = idx;
    } else if (this.isRunning()) {
      this.startXfade(0, XFADE_FRAMES);
    } else {
      this.seg = 0;
      this.pos = segs[0].start;
      this.resyncClick();
    }
    this.computeTrigger();
  }

  getProgram(): Program {
    return this.program;
  }

  // ---------------------------------------------------------------- transport

  play(opts: { countIn?: boolean } = {}): void {
    if (!this.song || this.program.segments.length === 0) return;
    if (this.state === 'playing' || this.state === 'countIn') return;
    const segs = this.program.segments;
    const cur = segs[this.seg];
    if (this.state === 'stopped' && this.seg === segs.length - 1 && this.pos >= cur.end - 1 && !this.program.loop) {
      this.seg = 0;
      this.pos = segs[0].start;
      this.resyncClick();
      this.computeTrigger();
    }
    if (opts.countIn && this.state === 'stopped') {
      this.beginCountIn();
      return;
    }
    this.state = 'playing';
  }

  pause(): void {
    if (this.state === 'playing') this.state = 'stopping';
    if (this.state === 'countIn') {
      this.state = 'stopped';
      this.master = 0;
    }
    this.pending = null;
    this.computeTrigger();
  }

  isPlaying(): boolean {
    return this.state === 'playing' || this.state === 'countIn';
  }

  /** Move to a source frame (in segment `segIndex`, or the one containing the frame). */
  seek(frame: Frame, segIndex?: number): void {
    const segs = this.program.segments;
    if (!this.song || segs.length === 0) return;
    const idx = segIndex ?? segmentAt(segs, frame);
    const s = segs[Math.max(0, Math.min(segs.length - 1, idx))];
    const f = Math.max(s.start, Math.min(s.end - 1, Math.round(frame)));
    this.pending = null;
    if (this.state === 'playing') {
      this.xf = { outPos: this.pos, i: 0, len: XFADE_FRAMES, toSilence: false };
    }
    this.seg = segs.indexOf(s);
    this.pos = f;
    this.stretcher?.reset();
    this.resyncClick();
    this.computeTrigger();
  }

  /**
   * Queue a jump to segment `to`. The boundary is resolved here, against the
   * downbeat grid, so it cannot be missed. The last request wins.
   */
  queueJump(to: number, q: Quantize): void {
    const segs = this.program.segments;
    if (!this.song || to < 0 || to >= segs.length) return;
    if (!this.isRunning()) {
      this.seg = to;
      this.pos = segs[to].start;
      this.pending = null;
      this.resyncClick();
      this.computeTrigger();
      this.emit({ type: 'jumped', to, frame: this.pos });
      return;
    }
    const cur = segs[this.seg];
    let at: Frame;
    if (q === 'now') {
      at = this.pos + XFADE_FRAMES;
    } else if (q === 'segmentEnd' || this.downbeats.length === 0) {
      at = cur.end;
    } else {
      const nb = nextDownbeat(this.downbeats, this.pos + XFADE_FRAMES - 1);
      at = nb === null ? cur.end : Math.min(nb, cur.end);
    }
    let len = q === 'now' ? XFADE_FRAMES : this.transition;
    let start = at - len;
    if (start < this.pos) {
      len = Math.max(32, at - this.pos);
      start = this.pos;
    }
    this.pending = { to, q, at, start, len };
    this.computeTrigger();
    this.emit({ type: 'armed', at, to });
  }

  cancelJump(): void {
    this.pending = null;
    this.computeTrigger();
  }

  get position(): CorePosition {
    return {
      frame: this.stretching && this.state !== 'stopped' ? Math.round(this.lastOut) + 1 : this.pos,
      segment: this.seg,
      playing: this.isPlaying(),
      pending: this.pending ? { at: this.pending.at, to: this.pending.to } : null,
    };
  }

  // ---------------------------------------------------------------- render

  /**
   * Render n frames into the output channels `outs` (2 for stereo, up to
   * MAX_OUTPUTS), following the routing. stemOuts[s] = [L, R] receives each
   * stem's raw (pre-gain) signal, used by export.
   */
  render(outs: Float32Array[], n: number, stemOuts: Float32Array[][] | null = null): void {
    for (const o of outs) o.fill(0, 0, n);
    if (stemOuts) for (const so of stemOuts) {
      so[0].fill(0, 0, n);
      so[1].fill(0, 0, n);
    }
    if (this.toneLeft > 0) this.renderTone(outs, n);
    const song = this.song;
    if (!song || this.state === 'stopped') return;
    this.ensureCapacity(n);

    if (this.state === 'countIn') {
      this.renderCountIn(outs, n);
      return;
    }

    const st = this.stretcher;
    this.stretching = st !== null && (this.speed !== 1 || st.buffered() > 0);
    if (this.stretching) {
      st!.process(n, this.stemBuf, this.srcPos, this.speed, this.pull);
    } else {
      this.fill(n, this.stemBuf, this.srcPos, 0);
    }
    this.lastOut = this.srcPos[n - 1];
    this.mix(outs, stemOuts, n);
  }

  // ---------------------------------------------------------------- internals

  private isRunning(): boolean {
    return this.state === 'playing' || this.state === 'stopping';
  }

  private emit(e: CoreEvent): void {
    this.onEvent?.(e);
  }

  private ensureCapacity(n: number): void {
    if (n <= this.cap && this.stemBuf.length === (this.song?.stems.length ?? 0)) return;
    const cap = Math.max(n, this.cap, 128);
    const stems = this.song?.stems.length ?? 0;
    this.stemBuf = Array.from({ length: stems }, () => [new Float32Array(cap), new Float32Array(cap)]);
    this.tmpL = new Float32Array(cap);
    this.tmpR = new Float32Array(cap);
    this.busL = new Float32Array(cap);
    this.busR = new Float32Array(cap);
    this.srcPos = new Float64Array(cap);
    this.cap = cap;
  }

  private nextIndex(i: number): number {
    if (this.repeat) return i;
    const len = this.program.segments.length;
    if (i + 1 < len) return i + 1;
    return this.program.loop ? 0 : -1;
  }

  private computeTrigger(): void {
    const segs = this.program.segments;
    if (!this.song || segs.length === 0) {
      this.trigger = Infinity;
      this.triggerKind = 'none';
      return;
    }
    const cur = segs[this.seg];
    const nx = this.nextIndex(this.seg);
    let t: Frame;
    let kind: TriggerKind;
    if (nx < 0) {
      t = cur.end - XFADE_FRAMES;
      kind = 'end';
    } else if (segs[nx].start === cur.end) {
      t = cur.end;
      kind = 'contig';
    } else {
      t = cur.end - this.joinLen();
      kind = 'xfade';
    }
    if (t < this.pos) t = this.pos;
    if (this.pending && this.pending.start <= t) {
      t = Math.max(this.pending.start, this.pos);
      kind = 'pending';
    }
    this.trigger = t;
    this.triggerKind = kind;
  }

  /** Crossfade length at a join between segments: loops stay tight, arrangements use the transition. */
  private joinLen(): number {
    return this.program.loop || this.repeat ? XFADE_FRAMES : this.transition;
  }

  /** Start a crossfade from the current position into the start of segment `to`. */
  private startXfade(to: number, len: number): void {
    const target = this.program.segments[to];
    this.xf = { outPos: this.pos, i: 0, len, toSilence: false };
    // May go negative near the song start; reads before frame 0 are silence.
    // After `len` frames the stream is exactly on target.start.
    this.pos = target.start - len;
    this.seg = to;
  }

  private handleTrigger(): void {
    const segs = this.program.segments;
    const cur = segs[this.seg];
    switch (this.triggerKind) {
      case 'pending': {
        const p = this.pending!;
        this.pending = null;
        this.startXfade(p.to, p.len);
        this.emit({ type: 'jumped', to: p.to, frame: segs[p.to].start });
        if (this.repeat) {
          // the vamp is over: the new section plays on as normal
          this.repeat = false;
          this.emit({ type: 'repeat', on: false });
        }
        break;
      }
      case 'contig': {
        this.seg = this.nextIndex(this.seg);
        this.emit({ type: 'segment', index: this.seg });
        break;
      }
      case 'xfade': {
        const nx = this.nextIndex(this.seg);
        const len = Math.max(32, Math.min(this.joinLen(), cur.end - this.pos));
        this.startXfade(nx, len);
        this.emit({ type: 'segment', index: nx });
        break;
      }
      case 'end': {
        const len = Math.max(1, Math.min(XFADE_FRAMES, cur.end - this.pos));
        this.xf = { outPos: this.pos, i: 0, len, toSilence: true };
        break;
      }
      default:
        this.trigger = Infinity;
        return;
    }
    this.computeTrigger();
  }

  /**
   * Produce `n` frames of the timeline stream for every stem into bufs[s][ch]
   * at `off`, and the source frame of each into pos[]. Returns frames written
   * (always n; after the program ends the rest is silence).
   */
  fill(n: number, bufs: Float32Array[][], posOut: Float64Array, off: number): number {
    const song = this.song!;
    const stems = song.stems;
    let i = off;
    const end = off + n;
    let guard = 0;
    while (i < end) {
      if (this.state === 'stopped') {
        for (const b of bufs) {
          b[0].fill(0, i, end);
          b[1].fill(0, i, end);
        }
        posOut.fill(this.pos, i, end);
        break;
      }
      const xf = this.xf;
      if (xf) {
        const k = Math.min(end - i, xf.len - xf.i);
        for (let s = 0; s < stems.length; s++) {
          const [dl, dr] = bufs[s];
          readRun(stems[s], xf.outPos, k, this.tmpL, this.tmpR, 0);
          if (xf.toSilence) {
            for (let j = 0; j < k; j++) {
              const g = Math.cos(HALF_PI * ((xf.i + j + 0.5) / xf.len));
              dl[i + j] = this.tmpL[j] * g;
              dr[i + j] = this.tmpR[j] * g;
            }
          } else {
            readRun(stems[s], this.pos, k, dl, dr, i);
            for (let j = 0; j < k; j++) {
              const th = HALF_PI * ((xf.i + j + 0.5) / xf.len);
              const go = Math.cos(th);
              const gi = Math.sin(th);
              dl[i + j] = dl[i + j] * gi + this.tmpL[j] * go;
              dr[i + j] = dr[i + j] * gi + this.tmpR[j] * go;
            }
          }
        }
        for (let j = 0; j < k; j++) posOut[i + j] = (xf.toSilence ? xf.outPos : this.pos) + j;
        xf.outPos += k;
        xf.i += k;
        if (!xf.toSilence) this.pos += k;
        i += k;
        if (xf.i >= xf.len) {
          this.xf = null;
          if (xf.toSilence) {
            const cur = this.program.segments[this.seg];
            this.pos = cur.end;
            this.state = 'stopped';
            this.master = 0;
            this.emit({ type: 'ended' });
          }
        }
        continue;
      }
      if (this.pos >= this.trigger) {
        this.handleTrigger();
        if (++guard > 64) {
          // pathological program (e.g. zero-length segments): stop instead of spinning
          this.state = 'stopped';
          this.emit({ type: 'ended' });
        }
        continue;
      }
      const k = Math.min(end - i, this.trigger - this.pos);
      for (let s = 0; s < stems.length; s++) readRun(stems[s], this.pos, k, bufs[s][0], bufs[s][1], i);
      for (let j = 0; j < k; j++) posOut[i + j] = this.pos + j;
      this.pos += k;
      i += k;
    }
    // advance the segment index eagerly at an exact contiguous boundary
    if (this.xf === null && this.state !== 'stopped' && this.triggerKind === 'contig' && this.pos >= this.trigger) {
      this.handleTrigger();
    }
    return n;
  }

  private mix(outs: Float32Array[], stemOuts: Float32Array[][] | null, n: number): void {
    const song = this.song!;
    const stems = song.stems;
    const anySolo = this.params.some((p) => p.solo);
    const step = 1 / RAMP_FRAMES;
    const nOut = outs.length;
    const tL = this.tmpL;
    const tR = this.tmpR;
    const busL = this.busL;
    const busR = this.busR;
    busL.fill(0, 0, n);
    busR.fill(0, 0, n);
    const mg = this.masterGain;
    for (let s = 0; s < stems.length; s++) {
      const [bl, br] = this.stemBuf[s];
      if (stemOuts && stemOuts[s]) {
        stemOuts[s][0].set(bl.subarray(0, n));
        stemOuts[s][1].set(br.subarray(0, n));
      }
      const p = this.params[s];
      const audible = !p.mute && (!anySolo || p.solo);
      const tl = audible ? p.gain * mg * (p.pan > 0 ? 1 - p.pan : 1) : 0;
      const tr = audible ? p.gain * mg * (p.pan < 0 ? 1 + p.pan : 1) : 0;
      let gL = this.gl[s];
      let gR = this.gr[s];
      if (gL === tl && gR === tr) {
        if (gL === 0 && gR === 0) continue;
        for (let i = 0; i < n; i++) {
          tL[i] = bl[i] * gL;
          tR[i] = br[i] * gR;
        }
      } else {
        for (let i = 0; i < n; i++) {
          gL = gL < tl ? Math.min(tl, gL + step) : Math.max(tl, gL - step);
          gR = gR < tr ? Math.min(tr, gR + step) : Math.max(tr, gR - step);
          tL[i] = bl[i] * gL;
          tR[i] = br[i] * gR;
        }
        this.gl[s] = gL;
        this.gr[s] = gR;
      }
      for (let i = 0; i < n; i++) {
        busL[i] += tL[i];
        busR[i] += tR[i];
      }
      const dests = this.routing.stems[s] ?? STEREO_DEST;
      for (const d of dests) {
        if ('ch' in d) {
          if (d.ch < 0 || d.ch >= nOut) continue;
          const o = outs[d.ch];
          for (let i = 0; i < n; i++) o[i] += 0.5 * (tL[i] + tR[i]);
        } else {
          if (d.l >= 0 && d.l < nOut) {
            const o = outs[d.l];
            for (let i = 0; i < n; i++) o[i] += tL[i];
          }
          if (d.r >= 0 && d.r < nOut) {
            const o = outs[d.r];
            for (let i = 0; i < n; i++) o[i] += tR[i];
          }
        }
      }
    }
    this.renderClick(outs, n);
    this.applyMaster(outs, n);
    this.measure(outs, n);
  }

  private measure(outs: Float32Array[], n: number): void {
    let pl = 0;
    let pr = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(this.busL[i]);
      const b = Math.abs(this.busR[i]);
      if (a > pl) pl = a;
      if (b > pr) pr = b;
    }
    // the play/pause ramp scales what is heard; use its level at the end of the block
    pl *= this.master;
    pr *= this.master;
    if (pl > this.meterL) this.meterL = pl;
    if (pr > this.meterR) this.meterR = pr;
    if (!this.clipped) {
      for (const o of outs) {
        for (let i = 0; i < n; i++) {
          if (o[i] > 1 || o[i] < -1) {
            this.clipped = true;
            return;
          }
        }
      }
    }
  }

  private applyMaster(outs: Float32Array[], n: number): void {
    const target = this.state === 'playing' ? 1 : 0;
    let m = this.master;
    if (m === target && m === 1) return;
    const step = 1 / RAMP_FRAMES;
    const ramp = this.tmpL; // reuse scratch: per-frame master gain
    for (let i = 0; i < n; i++) {
      m = m < target ? Math.min(target, m + step) : Math.max(target, m - step);
      ramp[i] = m;
    }
    for (const o of outs) for (let i = 0; i < n; i++) o[i] *= ramp[i];
    this.master = m;
    if (this.state === 'stopping' && m === 0) {
      this.state = 'stopped';
      this.xf = null;
      if (this.stretching && this.stretcher) {
        // the stretcher read ahead; resume from what was actually heard
        const segs = this.program.segments;
        this.pos = Math.round(this.lastOut) + 1;
        this.seg = segmentAt(segs, this.pos);
        this.stretcher.reset();
        this.stretching = false;
        this.resyncClick();
        this.computeTrigger();
      }
    }
  }

  private resyncClick(): void {
    this.nextBeat = lowerBound(this.beats, this.pos);
    this.lastSrc = this.pos - 1;
  }

  private addClickSample(outs: Float32Array[], i: number, v: number): void {
    const chans = this.routing.click;
    for (let k = 0; k < chans.length; k++) {
      const c = chans[k];
      if (c >= 0 && c < outs.length) outs[c][i] += v;
    }
  }

  private renderTone(outs: Float32Array[], n: number): void {
    const ch = this.toneCh;
    const total = Math.round(0.6 * this.sampleRate);
    const fade = 480;
    const w = (2 * Math.PI * 1000) / this.sampleRate;
    for (let i = 0; i < n && this.toneLeft > 0; i++, this.toneLeft--) {
      const t = this.tonePhase++;
      const env = Math.min(1, t / fade, this.toneLeft / fade);
      if (ch >= 0 && ch < outs.length && t < total * 10) outs[ch][i] += 0.25 * env * Math.sin(w * t);
    }
  }

  private renderClick(outs: Float32Array[], n: number): void {
    const beats = this.beats;
    const tol = SPLICE_TOLERANCE;
    for (let i = 0; i < n; i++) {
      const p = this.srcPos[i];
      if (p < this.lastSrc - tol || p > this.lastSrc + tol) {
        // a real discontinuity (jump, loop, seek), not a stretcher splice
        this.lastSrc = p - 1;
        this.nextBeat = lowerBound(beats, p);
      }
      // track the furthest point heard: stretcher splices repeat audio, clicks must not repeat
      if (p > this.lastSrc) this.lastSrc = p;
      const hi = this.lastSrc;
      if (this.nextBeat < beats.length && hi >= beats[this.nextBeat]) {
        const late = hi - beats[this.nextBeat];
        const accent = this.isDownbeat[this.nextBeat] === 1;
        while (this.nextBeat < beats.length && beats[this.nextBeat] <= hi) this.nextBeat++;
        if (this.click.enabled && late < 2400) {
          this.clickBuf = accent ? this.clickHi : this.clickLo;
          this.clickIdx = 0;
        }
      }
      if (this.clickBuf) {
        this.addClickSample(outs, i, this.clickBuf[this.clickIdx++] * this.click.gain);
        if (this.clickIdx >= this.clickBuf.length) this.clickBuf = null;
      }
    }
  }

  // ---------------------------------------------------------------- count-in

  private beginCountIn(): void {
    // one bar of clicks at the local bar length before the music starts
    const db = this.downbeats;
    let bar = 2 * this.sampleRate;
    if (db.length >= 2) {
      const i = Math.max(1, Math.min(db.length - 1, lowerBound(db, this.pos)));
      bar = db[i] - db[i - 1];
    }
    const beatsPerBar = 4;
    const len = Math.round(bar / this.speed);
    this.countInLen = len;
    this.countInLeft = len;
    this.countInBeats = Array.from({ length: beatsPerBar }, (_, k) => Math.round((k * len) / beatsPerBar));
    this.countInBeatIdx = 0;
    this.state = 'countIn';
    this.master = 1;
  }

  private renderCountIn(outs: Float32Array[], n: number): void {
    let i = 0;
    for (; i < n && this.countInLeft > 0; i++) {
      const t = this.countInLen - this.countInLeft;
      if (this.countInBeatIdx < this.countInBeats.length && t >= this.countInBeats[this.countInBeatIdx]) {
        this.clickBuf = this.countInBeatIdx === 0 ? this.clickHi : this.clickLo;
        this.clickIdx = 0;
        this.countInBeatIdx++;
      }
      if (this.clickBuf) {
        this.addClickSample(outs, i, this.clickBuf[this.clickIdx++] * Math.max(this.click.gain, 0.5));
        if (this.clickIdx >= this.clickBuf.length) this.clickBuf = null;
      }
      this.countInLeft--;
    }
    if (this.countInLeft <= 0) {
      this.state = 'playing';
      this.master = 0;
      this.resyncClick();
      // the remainder of this block is rendered as normal playback next call
    }
  }
}
