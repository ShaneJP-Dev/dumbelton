/// <reference lib="es2022" />
// AudioWorklet: wraps RenderCore. Runs on the audio thread.
import { RenderCore } from '../core/RenderCore';
import { LinkedWsola } from '../core/LinkedWsola';
import { stemFromCompact } from '../core/StemBlocks';
import type { Grid, SongPcm } from '../core/types';
import type { FromWorklet, ToWorklet } from '../engine/protocol';

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: unknown): void;

const REPORT_EVERY = 4; // blocks (~10 ms at 128 frames / 48 kHz)

class EngineProcessor extends AudioWorkletProcessor {
  private core = new RenderCore(sampleRate);
  private slots: ({ song: SongPcm; grid: Grid } | null)[] = [null, null];
  private active = -1;
  private blocks = 0;

  constructor() {
    super();
    this.core.setStretcher(new LinkedWsola(sampleRate));
    this.core.onEvent = (event) => {
      this.post({ type: 'event', event, songId: this.songId() });
      this.report();
    };
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.handle(e.data);
  }

  private songId(): string | null {
    return this.active >= 0 ? (this.slots[this.active]?.song.id ?? null) : null;
  }

  private post(m: FromWorklet): void {
    this.port.postMessage(m);
  }

  private handle(m: ToWorklet): void {
    const core = this.core;
    switch (m.type) {
      case 'load': {
        const song: SongPcm = { id: m.song.id, length: m.song.length, stems: m.song.stems.map(stemFromCompact) };
        this.slots[m.slot] = { song, grid: m.grid };
        this.post({ type: 'loaded', slot: m.slot, songId: song.id });
        break;
      }
      case 'activate': {
        const s = this.slots[m.slot];
        this.active = s ? m.slot : -1;
        core.setSong(s ? s.song : null, s ? s.grid : undefined);
        this.post({ type: 'activated', slot: m.slot, songId: this.songId() });
        break;
      }
      case 'unload':
        if (m.slot === this.active) {
          core.setSong(null);
          this.active = -1;
        }
        this.slots[m.slot] = null;
        break;
      case 'play':
        core.play({ countIn: m.countIn });
        break;
      case 'pause':
        core.pause();
        break;
      case 'seek':
        core.seek(m.frame, m.segment);
        break;
      case 'program':
        core.setProgram(m.program);
        break;
      case 'jump':
        core.queueJump(m.to, m.q);
        break;
      case 'cancelJump':
        core.cancelJump();
        break;
      case 'stem':
        core.setStem(m.index, m.params);
        break;
      case 'click':
        core.setClick(m.params);
        break;
      case 'speed':
        core.setSpeed(m.speed);
        break;
      case 'grid':
        core.setGrid(m.grid);
        if (this.active >= 0 && this.slots[this.active]) this.slots[this.active]!.grid = m.grid;
        break;
    }
    this.report();
  }

  private report(): void {
    const p = this.core.position;
    this.post({
      type: 'pos',
      frame: p.frame,
      segment: p.segment,
      playing: p.playing,
      pending: p.pending,
      time: currentTime,
      speed: this.core.getSpeed(),
      songId: this.songId(),
    });
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length < 2) return true;
    const n = out[0].length;
    this.core.render(out, n);
    if (++this.blocks % REPORT_EVERY === 0) this.report();
    return true;
  }
}

registerProcessor('musical-engine', EngineProcessor);
