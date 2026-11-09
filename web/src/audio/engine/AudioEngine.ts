import workletUrl from '../worklet/engine.worklet.ts?worker&url';
import type { ClickParams } from '../core/RenderCore';
import type { CoreEvent, CueParams, Frame, Grid, Program, Quantize, Routing, StemParams } from '../core/types';
import { MAX_OUTPUTS, SAMPLE_RATE } from '../core/types';
import { PositionClock } from './PositionClock';
import type { FromWorklet, ToWorklet, WireSong } from './protocol';
import { configureAudioSession, keepAlive } from './session';

type Listener = (e: CoreEvent, songId: string | null) => void;

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };

/** Use as many output channels as the device offers (up to 32), one-to-one, no up/down-mixing. */
function configureDestination(ctx: AudioContext): number {
  const d = ctx.destination;
  const n = Math.max(1, Math.min(MAX_OUTPUTS, d.maxChannelCount || 2));
  d.channelCount = n;
  d.channelCountMode = 'explicit';
  d.channelInterpretation = 'discrete';
  return n;
}

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
  private meterPeak: [number, number] = [0, 0];
  private meterClip = false;
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
    // Always render 32 channels; the destination keeps as many as the device has
    // (a stereo device simply gets channels 1-2).
    const node = new AudioWorkletNode(ctx, 'musical-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [MAX_OUTPUTS],
      channelInterpretation: 'discrete',
    });
    configureDestination(ctx);
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
        // keep the loudest value until the UI reads it (reports come faster than screen frames)
        if (m.meter[0] > this.meterPeak[0]) this.meterPeak[0] = m.meter[0];
        if (m.meter[1] > this.meterPeak[1]) this.meterPeak[1] = m.meter[1];
        if (m.clip) this.meterClip = true;
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
  /** Last track settings sent to the audio thread (for display and tests). */
  readonly stemParams: Partial<StemParams>[] = [];

  setStem(index: number, params: Partial<StemParams>): void {
    this.stemParams[index] = { ...this.stemParams[index], ...params };
    this.send({ type: 'stem', index, params });
  }
  /** Last click settings sent to the audio thread (for tests). */
  readonly clickParams: Partial<ClickParams> = {};

  setClick(params: Partial<ClickParams>): void {
    Object.assign(this.clickParams, params);
    this.send({ type: 'click', params });
  }
  /** Last key change sent to the audio thread, in semitones (for tests). */
  transpose = 0;
  /** Change the key without changing the tempo (-6..+6 semitones). */
  setTranspose(semitones: number): void {
    this.transpose = semitones;
    this.send({ type: 'transpose', semitones });
  }
  setSpeed(speed: number): void {
    this.send({ type: 'speed', speed });
  }
  /** Output channels the current device takes (2 for ordinary speakers, up to 32). */
  get outputChannels(): number {
    return this.ctx.destination.channelCount;
  }

  /** Whether the browser can choose the output device in-app (Chrome, Edge). */
  get canChooseDevice(): boolean {
    return typeof (this.ctx as SinkContext).setSinkId === 'function';
  }

  /** Send audio to a device ('' = system default). Returns the channels it takes. */
  async setOutputDevice(deviceId: string): Promise<number> {
    const ctx = this.ctx as SinkContext;
    if (ctx.setSinkId && (ctx.sinkId ?? '') !== deviceId) await ctx.setSinkId(deviceId);
    return configureDestination(this.ctx);
  }

  /** Song level (peak L/R, linear) and clipping since the last call. */
  readMeter(): { l: number; r: number; clip: boolean } {
    const m = { l: this.meterPeak[0], r: this.meterPeak[1], clip: this.meterClip };
    this.meterPeak = [0, 0];
    this.meterClip = false;
    return m;
  }

  /** Master level for the whole song (linear). */
  setMasterGain(gain: number): void {
    this.send({ type: 'master', gain });
  }

  setRouting(routing: Routing): void {
    this.send({ type: 'routing', routing });
  }

  /** Short beep on one output channel (0-based), to find it on the desk. */
  testTone(channel: number): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
    this.send({ type: 'testTone', channel });
  }

  /** Fade length (frames) for jumps between parts and arrangement joins. */
  setTransition(frames: number): void {
    this.send({ type: 'transition', frames });
  }
  /** Last Repeat (vamp) setting sent to the audio thread (for tests). */
  repeat = false;
  /** Live "Repeat": loop the current section until a queued jump lands. */
  setRepeat(on: boolean): void {
    this.repeat = on;
    this.send({ type: 'repeat', on });
  }
  /** Spoken cue words (mono, 48 kHz), indexed by CueParams.segClip. */
  setCueClips(clips: Float32Array[]): void {
    this.cueClipCount = clips.length;
    this.send({ type: 'cueClips', clips });
  }
  cueClipCount = 0;
  /** Last spoken-cue settings sent to the audio thread (for tests). */
  readonly cueParams: Partial<CueParams> = {};
  setCues(params: Partial<CueParams>): void {
    Object.assign(this.cueParams, params);
    this.send({ type: 'cues', params });
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
