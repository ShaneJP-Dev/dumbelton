import type { PosReport } from './protocol';

/**
 * Smooth playhead for the UI. The worklet reports its position every ~10 ms;
 * between reports we extrapolate using the AudioContext's output timestamp,
 * which accounts for output latency.
 */
export class PositionClock {
  private last: PosReport | null = null;
  constructor(private ctx: BaseAudioContext & { getOutputTimestamp?: () => AudioTimestamp }) {}

  update(r: PosReport): void {
    this.last = r;
  }

  get report(): PosReport | null {
    return this.last;
  }

  get playing(): boolean {
    return this.last?.playing ?? false;
  }

  /** Current audible source frame. */
  now(): number {
    const r = this.last;
    if (!r) return 0;
    if (!r.playing) return r.frame;
    const sr = this.ctx.sampleRate;
    const blockEnd = r.time + 128 / sr;
    let t: number;
    const ts = this.ctx instanceof AudioContext ? this.ctx.getOutputTimestamp() : undefined;
    if (ts && ts.contextTime !== undefined && ts.contextTime > 0) t = ts.contextTime;
    else t = this.ctx.currentTime - ((this.ctx as AudioContext).baseLatency ?? 0);
    // clamp extrapolation so a late report never runs the playhead away
    const dt = Math.max(-0.2, Math.min(0.1, t - blockEnd));
    return r.frame + dt * sr * r.speed;
  }
}
