// Backs up songs into a TAR file (streamed to OPFS) and restores them from one.
// Audio files are streamed in chunks, so big libraries never sit in memory.
import { MANIFEST_PATH, parseBackupPath, pcmPath, peaksPath } from '../../lib/backupFormat';
import { TarReader, tarEnd, tarHeader, tarPad } from '../../lib/tar';

interface Scope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: unknown, transfer?: Transferable[]): void;
}
const scope = globalThis as unknown as Scope;

interface SyncHandle {
  truncate(n: number): void;
  write(b: ArrayBufferView, o?: { at: number }): number;
  flush(): void;
  close(): void;
}

export type BackupRequest =
  | {
      type: 'backup';
      manifest: Uint8Array;
      files: { songId: string; stemId: string }[];
      peaks: { stemId: string; levels: Int8Array[] }[];
    }
  | { type: 'restore'; file: File; existingSongIds: string[] };

export type BackupReply =
  | { type: 'progress'; fraction: number }
  | { type: 'backedUp'; path: string; bytes: number }
  | {
      type: 'restored';
      manifest: Uint8Array | null;
      peaks: { stemId: string; level: number; bytes: Uint8Array }[];
      written: string[];
    }
  | { type: 'error'; message: string };

async function syncHandle(dir: FileSystemDirectoryHandle, name: string): Promise<SyncHandle> {
  const fh = await dir.getFileHandle(name, { create: true });
  const h = await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
  h.truncate(0);
  return h;
}

async function backup(req: Extract<BackupRequest, { type: 'backup' }>): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const songs = await root.getDirectoryHandle('songs', { create: true });
  const out = await root.getDirectoryHandle('exports', { create: true });
  const h = await syncHandle(out, 'backup.tar');
  let at = 0;
  const write = (b: Uint8Array) => {
    h.write(b, { at });
    at += b.byteLength;
  };
  try {
    // sizes first, for progress
    const sources = await Promise.all(
      req.files.map(async (f) => {
        const file = await (await (await songs.getDirectoryHandle(f.songId)).getFileHandle(`${f.stemId}.pcm`)).getFile();
        return { ...f, file };
      }),
    );
    const total = Math.max(1, sources.reduce((n, s) => n + s.file.size, 0));
    let done = 0;
    let lastReport = 0;

    write(tarHeader(MANIFEST_PATH, req.manifest.byteLength));
    write(req.manifest);
    write(new Uint8Array(tarPad(req.manifest.byteLength)));

    for (const s of sources) {
      write(tarHeader(pcmPath(s.songId, s.stemId), s.file.size));
      const reader = s.file.stream().getReader();
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        write(r.value);
        done += r.value.byteLength;
        if (done - lastReport > 8 * 1024 * 1024) {
          lastReport = done;
          scope.postMessage({ type: 'progress', fraction: done / total } satisfies BackupReply);
        }
      }
      write(new Uint8Array(tarPad(s.file.size)));
    }
    for (const p of req.peaks) {
      p.levels.forEach((lv, level) => {
        const bytes = new Uint8Array(lv.buffer, lv.byteOffset, lv.byteLength);
        write(tarHeader(peaksPath(p.stemId, level), bytes.byteLength));
        write(bytes);
        write(new Uint8Array(tarPad(bytes.byteLength)));
      });
    }
    write(tarEnd());
    h.flush();
  } finally {
    h.close();
  }
  scope.postMessage({ type: 'backedUp', path: 'backup.tar', bytes: at } satisfies BackupReply);
}

async function restore(req: Extract<BackupRequest, { type: 'restore' }>): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const songs = await root.getDirectoryHandle('songs', { create: true });
  const existing = new Set(req.existingSongIds);
  const tar = new TarReader();
  const peaks: { stemId: string; level: number; bytes: Uint8Array }[] = [];
  const written: string[] = [];
  let manifest: Uint8Array | null = null;

  // the entry being read
  let kind: ReturnType<typeof parseBackupPath> = { kind: 'other' };
  let name = '';
  let handle: SyncHandle | null = null;
  let at = 0;
  let mem: Uint8Array[] = [];

  const reader = req.file.stream().getReader();
  const total = Math.max(1, req.file.size);
  let read = 0;
  let lastReport = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      read += r.value.byteLength;
      for (const ev of tar.push(r.value)) {
        if (ev.type === 'start') {
          name = ev.name;
          kind = parseBackupPath(ev.name);
          at = 0;
          mem = [];
          if (kind.kind === 'pcm' && !existing.has(kind.songId)) {
            const dir = await songs.getDirectoryHandle(kind.songId, { create: true });
            handle = await syncHandle(dir, `${kind.stemId}.pcm`);
          }
        } else if (ev.type === 'data') {
          if (handle) {
            handle.write(ev.bytes, { at });
            at += ev.bytes.byteLength;
          } else if (kind.kind === 'manifest' || kind.kind === 'peaks') {
            mem.push(ev.bytes.slice());
          }
        } else if (ev.type === 'end') {
          if (handle) {
            handle.flush();
            handle.close();
            handle = null;
            written.push(name);
          } else if (kind.kind === 'manifest' || kind.kind === 'peaks') {
            const n = mem.reduce((s, b) => s + b.byteLength, 0);
            const all = new Uint8Array(n);
            let o = 0;
            for (const b of mem) {
              all.set(b, o);
              o += b.byteLength;
            }
            if (kind.kind === 'manifest') manifest = all;
            else peaks.push({ stemId: kind.stemId, level: kind.level, bytes: all });
          }
          mem = [];
        }
      }
      if (read - lastReport > 8 * 1024 * 1024) {
        lastReport = read;
        scope.postMessage({ type: 'progress', fraction: read / total } satisfies BackupReply);
      }
      if (tar.done) break;
    }
  } finally {
    if (handle) (handle as SyncHandle).close();
  }
  if (!tar.done && !manifest) throw new Error('This file is not a backup (or it is incomplete).');
  scope.postMessage(
    { type: 'restored', manifest, peaks, written } satisfies BackupReply,
    [...(manifest ? [manifest.buffer] : []), ...peaks.map((p) => p.bytes.buffer)] as Transferable[],
  );
}

scope.onmessage = async (e: MessageEvent<BackupRequest>) => {
  try {
    if (e.data.type === 'backup') await backup(e.data);
    else await restore(e.data);
  } catch (err) {
    scope.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) } satisfies BackupReply);
  }
};
