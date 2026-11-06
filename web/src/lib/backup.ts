import type { BackupReply, BackupRequest } from '../audio/export/backup.worker';
import { deleteSongPcm } from '../audio/import/pcmStore';
import { backupFileName, decodeManifest, encodeManifest, pcmPath, setlistsToRestore } from './backupFormat';
import { db } from './db';
import type { ExportedFile } from './exporter';
import type { PeaksRecord } from './types';

function run(req: BackupRequest, onProgress: (f: number) => void): Promise<BackupReply> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../audio/export/backup.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<BackupReply>) => {
      if (e.data.type === 'progress') return onProgress(e.data.fraction);
      w.terminate();
      if (e.data.type === 'error') reject(new Error(e.data.message));
      else resolve(e.data);
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'backup failed'));
    };
    w.postMessage(req);
  });
}

/** Write the chosen songs (and the setlists that use them) into one backup file. */
export async function createBackup(projectIds: string[], onProgress: (f: number) => void): Promise<ExportedFile> {
  const projects = (await db.projects.bulkGet(projectIds)).filter((p): p is NonNullable<typeof p> => !!p);
  const ids = new Set(projects.map((p) => p.id));
  const setlists = (await db.setlists.toArray())
    .map((sl) => ({ ...sl, entries: sl.entries.filter((e) => ids.has(e.projectId)) }))
    .filter((sl) => sl.entries.length > 0);
  const peaks = await db.peaks.where('songId').anyOf([...ids]).toArray();
  const reply = await run(
    {
      type: 'backup',
      manifest: encodeManifest(projects, setlists),
      files: projects.flatMap((p) => p.stems.map((s) => ({ songId: p.id, stemId: s.id }))),
      peaks: peaks.map((p) => ({ stemId: p.stemId, levels: p.levels })),
    },
    onProgress,
  );
  if (reply.type !== 'backedUp') throw new Error('backup failed');
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('exports');
  const raw = await (await dir.getFileHandle(reply.path)).getFile();
  const name = backupFileName();
  return { name, file: new File([raw], name, { type: 'application/x-tar' }) };
}

export interface RestoreResult {
  restored: string[];
  alreadyHere: string[];
  damaged: string[];
  setlists: number;
}

/** Add the songs and setlists in a backup file. Songs already here are left as they are. */
export async function restoreBackup(file: File, onProgress: (f: number) => void): Promise<RestoreResult> {
  const existingSongIds = await db.projects.toCollection().primaryKeys();
  const reply = await run({ type: 'restore', file, existingSongIds }, onProgress);
  if (reply.type !== 'restored') throw new Error('restore failed');
  if (!reply.manifest) throw new Error('This file is not a backup (it has no song list).');
  const { projects, setlists } = decodeManifest(reply.manifest);
  const existing = new Set(existingSongIds);
  const written = new Set(reply.written);
  const result: RestoreResult = { restored: [], alreadyHere: [], damaged: [], setlists: 0 };

  for (const p of projects) {
    if (existing.has(p.id)) {
      result.alreadyHere.push(p.name);
      continue;
    }
    if (!p.stems.every((s) => written.has(pcmPath(p.id, s.id)))) {
      result.damaged.push(p.name);
      await deleteSongPcm(p.id);
      continue;
    }
    const stemIds = new Set(p.stems.map((s) => s.id));
    const byStem = new Map<string, Int8Array[]>();
    for (const pk of reply.peaks) {
      if (!stemIds.has(pk.stemId)) continue;
      const levels = byStem.get(pk.stemId) ?? [];
      levels[pk.level] = new Int8Array(pk.bytes.buffer, pk.bytes.byteOffset, pk.bytes.byteLength);
      byStem.set(pk.stemId, levels);
    }
    const peakRecords: PeaksRecord[] = [...byStem].map(([stemId, levels]) => ({ stemId, songId: p.id, levels }));
    await db.transaction('rw', db.projects, db.peaks, async () => {
      await db.projects.put(p);
      if (peakRecords.length) await db.peaks.bulkPut(peakRecords);
    });
    result.restored.push(p.name);
  }

  const songIds = new Set([...existing, ...projects.filter((p) => result.restored.includes(p.name)).map((p) => p.id)]);
  const existingSetlists = new Set(await db.setlists.toCollection().primaryKeys());
  const newSetlists = setlistsToRestore(setlists, existingSetlists, songIds);
  if (newSetlists.length) await db.setlists.bulkPut(newSetlists);
  result.setlists = newSetlists.length;
  return result;
}
