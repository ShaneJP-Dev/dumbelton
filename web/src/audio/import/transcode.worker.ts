// Dedicated worker: converts decoded audio to the compact stored format and writes it to OPFS.
import { transcode } from './transcode';

interface Scope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: unknown, transfer?: Transferable[]): void;
}
const scope = globalThis as unknown as Scope;

export interface TranscodeRequest {
  type: 'transcode';
  songId: string;
  stemId: string;
  channels: Float32Array[];
}

interface SyncHandle {
  truncate(n: number): void;
  write(b: BufferSource, o?: { at: number }): number;
  flush(): void;
  close(): void;
}

async function writeOpfs(songId: string, stemId: string, data: ArrayBuffer): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const songs = await root.getDirectoryHandle('songs', { create: true });
  const dir = await songs.getDirectoryHandle(songId, { create: true });
  const fh = await dir.getFileHandle(`${stemId}.pcm`, { create: true });
  const h = (await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle());
  try {
    h.truncate(0);
    h.write(new Uint8Array(data), { at: 0 });
    h.flush();
  } finally {
    h.close();
  }
}

scope.onmessage = async (e: MessageEvent<TranscodeRequest>) => {
  const m = e.data;
  try {
    const { compact, peaks } = transcode(m.stemId, m.channels);
    await writeOpfs(m.songId, m.stemId, compact.data);
    scope.postMessage(
      {
        type: 'done',
        stemId: m.stemId,
        channels: compact.channels,
        length: compact.length,
        present: compact.present,
        bytes: compact.data.byteLength,
        peaks,
      },
      peaks.map((p) => p.buffer as ArrayBuffer),
    );
  } catch (err) {
    scope.postMessage({ type: 'error', stemId: m.stemId, message: String((err as Error)?.message ?? err) });
  }
};
