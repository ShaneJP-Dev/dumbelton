// Sums the stems chosen for analysis into a mono 16-bit WAV (48 kHz) for the analyzer.
import { readRun, stemFromCompact } from '../core/StemBlocks';
import { SAMPLE_RATE } from '../core/types';
import { encodeWav } from '../export/wav';

interface Scope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: unknown, transfer?: Transferable[]): void;
}
const scope = globalThis as unknown as Scope;

export interface MixdownRequest {
  songId: string;
  lengthFrames: number;
  stems: { id: string; channels: 1 | 2; length: number; present: Uint8Array }[];
}

scope.onmessage = async (e: MessageEvent<MixdownRequest>) => {
  const { songId, lengthFrames, stems } = e.data;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('songs')).getDirectoryHandle(songId);
    const mix = new Float32Array(lengthFrames);
    const CH = 65536;
    const L = new Float32Array(CH);
    const R = new Float32Array(CH);
    for (const s of stems) {
      const data = await (await (await dir.getFileHandle(`${s.id}.pcm`)).getFile()).arrayBuffer();
      const stem = stemFromCompact({ ...s, data });
      for (let f = 0; f < lengthFrames; f += CH) {
        const n = Math.min(CH, lengthFrames - f);
        readRun(stem, f, n, L, R, 0);
        for (let i = 0; i < n; i++) mix[f + i] += 0.5 * (L[i] + R[i]);
      }
    }
    let peak = 0;
    for (let i = 0; i < mix.length; i++) peak = Math.max(peak, Math.abs(mix[i]));
    if (peak > 0) {
      const g = 0.9 / peak;
      for (let i = 0; i < mix.length; i++) mix[i] *= g;
    }
    const wav = encodeWav([mix], SAMPLE_RATE, 16);
    scope.postMessage({ type: 'done', wav }, [wav]);
  } catch (err) {
    scope.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
