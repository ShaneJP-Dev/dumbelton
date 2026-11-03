import workletUrl from '../worklet/engine.worklet.ts?worker&url';
import type { ClickParams } from '../core/RenderCore';
import type { CoreEvent, Frame, Grid, Program, Quantize, StemParams } from '../core/types';
import { SAMPLE_RATE } from '../core/types';
import { PositionClock } from './PositionClock';
import type { FromWorklet, ToWorklet, WireSong } from './protocol';
import { configureAudioSession, keepAlive } from './session';

type Listener = (e: CoreEvent, songId: string | null) => void;

/**
 * Main-thread handle on the audio engine. Create it from a user gesture.
 * All audio work happens in the worklet; this class only sends messages.
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly node: AudioWorkletNode;
  readonly clock: PositionClock;
  private listeners = new Set<Listener>();
  private posListeners = new Set<() => void>();
  private loadWaiters = new Map<number, (songId: string) => void>();
  /** Song id held in each slot (0, 1). */
  readonly slots: (string | null)[] = [null, null];
  activeSlot = -1;

  private constructor(ctx: AudioContext, node: AudioWorkletNode) {
    this.ctx = ctx;
    this.node = node;
    this.clock = new PositionClock(ctx);
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.onMessage(e.data);
  }

  static async create(): Promise<AudioEngine> {
    configureAudioSession();
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'musical-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(ctx.destination);
    keepAlive(ctx);
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
    return new AudioEngine(ctx, node);
  }

  get activeSongId(): string | null {
    return this.activeSlot >= 0 ? this.slots[this.activeSlot] : null;
  }

  private send(m: ToWorklet, transfer: Transferable[] = []): void {
    this.node.port.postMessage(m, transfer);
  }

  private onMessage(m: FromWorklet): void {
    switch (m.type) {
      case 'pos':
        this.clock.update(m);
        this.posListeners.forEach((l) => l());
        break;
      case 'event':
        this.listeners.forEach((l) => l(m.event, m.songId));
        break;
      case 'loaded':
        this.loadWaiters.get(m.slot)?.(m.songId);
        this.loadWaiters.delete(m.slot);
        break;
      case 'activated':
        break;
    }
  }

  /** Transfer a song's PCM into a worklet slot. The buffers are moved, not copied. */
  load(slot: 0 | 1, song: WireSong, grid: Grid): Promise<void> {
    return new Promise((resolve) => {
      this.loadWaiters.set(slot, () => resolve());
      this.slots[slot] = song.id;
      this.send(
        { type: 'load', slot, song, grid },
        song.stems.map((s) => s.data),
      );
    });
  }

  activate(slot: 0 | 1): void {
    this.activeSlot = slot;
    this.send({ type: 'activate', slot });
  }

  unload(slot: 0 | 1): void {
    this.slots[slot] = null;
    if (this.activeSlot === slot) this.activeSlot = -1;
    this.send({ type: 'unload', slot });
  }

  play(opts: { countIn?: boolean } = {}): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
    this.send({ type: 'play', countIn: opts.countIn });
  }
  pause(): void {
    this.send({ type: 'pause' });
  }
  seek(frame: Frame, segment?: number): void {
    this.send({ type: 'seek', frame, segment });
  }
  setProgram(program: Program): void {
    this.send({ type: 'program', program });
  }
  queueJump(to: number, q: Quantize): void {
    this.send({ type: 'jump', to, q });
  }
  cancelJump(): void {
    this.send({ type: 'cancelJump' });
  }
  setStem(index: number, params: Partial<StemParams>): void {
    this.send({ type: 'stem', index, params });
  }
  setClick(params: Partial<ClickParams>): void {
    this.send({ type: 'click', params });
  }
  setSpeed(speed: number): void {
    this.send({ type: 'speed', speed });
  }
  setGrid(grid: Grid): void {
    this.send({ type: 'grid', grid });
  }

  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onPosition(cb: () => void): () => void {
    this.posListeners.add(cb);
    return () => this.posListeners.delete(cb);
  }
}
