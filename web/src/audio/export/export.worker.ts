// Renders an arrangement with the same RenderCore used for playback, streaming
// 24-bit WAVs (mix and/or each stem) to OPFS, then zipping the stems.
import { Zip, ZipPassThrough } from 'fflate';
import { LinkedWsola } from '../core/LinkedWsola';
import { RenderCore } from '../core/RenderCore';
import { stemFromCompact } from '../core/StemBlocks';
import { SAMPLE_RATE, type Grid, type Program } from '../core/types';
import { renderProgram } from './render';
import { encodePcm, wavHeader } from './wav';

interface Scope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: unknown): void;
}
const scope = globalThis as unknown as Scope;

interface SyncHandle {
  truncate(n: number): void;
  write(b: BufferSource, o?: { at: number }): number;
  read(b: BufferSource, o?: { at: number }): number;
  getSize(): number;
  flush(): void;
  close(): void;
}

export interface ExportRequest {
  songId: string;
  baseName: string;
  stems: {
    id: string;
    name: string;
    channels: 1 | 2;
    length: number;
    present: Uint8Array;
    gain: number;
    pan: number;
    muted: boolean;
    solo: boolean;
  }[];
  grid: Grid;
  program: Program;
  speed: number;
  /** Key change in semitones. */
  transpose: number;
  /** Fade length (frames) at arrangement joins, as in playback. */
  transition: number;
  /** The song's master level (linear) for the mix. */
  masterGain: number;
  click: boolean;
  mix: boolean;
  stemFiles: boolean;
}

export type ExportReply =
  | { type: 'progress'; fraction: number; stage: 'render' | 'zip' }
  | { type: 'done'; files: { path: string; name: string }[]; clipped: boolean; frames: number }
  | { type: 'error'; message: string };

const BITS = 24;

async function exportsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('exports', { create: true });
}

async function openSync(dir: FileSystemDirectoryHandle, name: string): Promise<SyncHandle> {
  const fh = await dir.getFileHandle(name, { create: true });
  const h = await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
  h.truncate(0);
  return h;
}

class WavStream {
  private at = 44;
  private bytes = 0;
  private buf = new Uint8Array(0);
  constructor(private h: SyncHandle, private channels: number) {}
  write(ch: Float32Array[], n: number): void {
    const need = n * this.channels * (BITS / 8);
    if (this.buf.byteLength < need) this.buf = new Uint8Array(need);
    const view = this.buf.subarray(0, need);
    encodePcm(ch, n, BITS, view);
    this.h.write(view, { at: this.at });
    this.at += need;
    this.bytes += need;
  }
  finish(): void {
    this.h.write(new Uint8Array(wavHeader(this.bytes, this.channels, SAMPLE_RATE, BITS)), { at: 0 });
    this.h.flush();
    this.h.close();
  }
}

function safe(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'export';
}

scope.onmessage = async (e: MessageEvent<ExportRequest>) => {
  const req = e.data;
  const handles: SyncHandle[] = [];
  try {
    const root = await navigator.storage.getDirectory();
    const songDir = await (await root.getDirectoryHandle('songs')).getDirectoryHandle(req.songId);
    const stems = await Promise.all(
      req.stems.map(async (s) => {
        const data = await (await (await songDir.getFileHandle(`${s.id}.pcm`)).getFile()).arrayBuffer();
        return stemFromCompact({ id: s.id, channels: s.channels, length: s.length, present: s.present, data });
      }),
    );
    const length = Math.max(...req.stems.map((s) => s.length));
    const core = new RenderCore(SAMPLE_RATE);
    core.setSong({ id: req.songId, length, stems }, req.grid);
    req.stems.forEach((s, i) => core.setStem(i, { gain: s.gain, pan: s.pan, mute: s.muted, solo: s.solo }));
    core.setClick({ enabled: req.click });
    core.setStretcher(new LinkedWsola(SAMPLE_RATE));
    core.setSpeed(req.speed);
    core.setTranspose(req.transpose);
    core.setTransition(req.transition);
    core.setMasterGain(req.masterGain);

    const dir = await exportsDir();
    // clear previous exports
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      await dir.removeEntry(name).catch(() => undefined);
    }
    const files: { path: string; name: string }[] = [];
    let mixOut: WavStream | null = null;
    if (req.mix) {
      const h = await openSync(dir, 'mix.wav');
      handles.push(h);
      mixOut = new WavStream(h, 2);
      files.push({ path: 'mix.wav', name: `${safe(req.baseName)}.wav` });
    }
    const stemOut: WavStream[] = [];
    if (req.stemFiles) {
      for (let i = 0; i < stems.length; i++) {
        const h = await openSync(dir, `stem-${i}.wav`);
        handles.push(h);
        stemOut.push(new WavStream(h, stems[i].channels));
      }
    }
    let peak = 0;
    const frames = renderProgram(core, req.program, {
      speed: req.speed,
      stems: req.stemFiles ? stems.length : 0,
      onBlock: (main, so, n) => {
        if (mixOut) {
          for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(main[0][i]), Math.abs(main[1][i]));
          mixOut.write(main, n);
        }
        if (so) stemOut.forEach((w, i) => w.write(stems[i].channels === 1 ? [so[i][0]] : so[i], n));
      },
      onProgress: (fraction) => scope.postMessage({ type: 'progress', fraction, stage: 'render' } satisfies ExportReply),
    });
    mixOut?.finish();
    stemOut.forEach((w) => w.finish());
    handles.length = 0;

    if (req.stemFiles) {
      scope.postMessage({ type: 'progress', fraction: 0, stage: 'zip' } satisfies ExportReply);
      const zh = await openSync(dir, 'stems.zip');
      let at = 0;
      let zipErr: Error | null = null;
      const zip = new Zip((err, chunk) => {
        if (err) zipErr = err;
        else if (chunk.byteLength) {
          zh.write(chunk, { at });
          at += chunk.byteLength;
        }
      });
      const CHUNK = 1 << 20;
      for (let i = 0; i < stems.length; i++) {
        const h = await openSync2(dir, `stem-${i}.wav`);
        const entry = new ZipPassThrough(`${safe(req.baseName)}/${safe(req.stems[i].name)}.wav`);
        zip.add(entry);
        const size = h.getSize();
        for (let off = 0; off < size; off += CHUNK) {
          const n = Math.min(CHUNK, size - off);
          const b = new Uint8Array(n);
          h.read(b, { at: off });
          entry.push(b, off + n >= size);
        }
        if (size === 0) entry.push(new Uint8Array(0), true);
        h.close();
        await dir.removeEntry(`stem-${i}.wav`).catch(() => undefined);
        scope.postMessage({ type: 'progress', fraction: (i + 1) / stems.length, stage: 'zip' } satisfies ExportReply);
      }
      zip.end();
      zh.flush();
      zh.close();
      if (zipErr) throw zipErr;
      files.push({ path: 'stems.zip', name: `${safe(req.baseName)} - stems.zip` });
    }
    scope.postMessage({ type: 'done', files, clipped: peak > 1, frames } satisfies ExportReply);
  } catch (err) {
    for (const h of handles) {
      try {
        h.close();
      } catch {
        /* already closed */
      }
    }
    scope.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) } satisfies ExportReply);
  }
};

async function openSync2(dir: FileSystemDirectoryHandle, name: string): Promise<SyncHandle> {
  const fh = await dir.getFileHandle(name);
  return (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
}
