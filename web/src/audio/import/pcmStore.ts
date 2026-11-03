import type { WireSong } from '../engine/protocol';
import type { Project } from '../../lib/types';

export function opfsSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage && 'getDirectory' in navigator.storage;
}

async function songDir(songId: string, create = false): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const songs = await root.getDirectoryHandle('songs', { create: true });
  return songs.getDirectoryHandle(songId, { create });
}

/** Read a song's compact PCM files. Each stem becomes one ArrayBuffer (transferable). */
export async function loadWireSong(project: Project): Promise<WireSong> {
  const dir = await songDir(project.id);
  const stems = await Promise.all(
    project.stems.map(async (s) => {
      const fh = await dir.getFileHandle(`${s.id}.pcm`);
      const data = await (await fh.getFile()).arrayBuffer();
      return { id: s.id, channels: s.channels, length: s.length, present: s.present, data };
    }),
  );
  return { id: project.id, length: project.lengthFrames, stems };
}

export async function readStemFile(songId: string, stemId: string): Promise<ArrayBuffer> {
  const dir = await songDir(songId);
  const fh = await dir.getFileHandle(`${stemId}.pcm`);
  return (await fh.getFile()).arrayBuffer();
}

export async function deleteSongPcm(songId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const songs = await root.getDirectoryHandle('songs', { create: true });
    await songs.removeEntry(songId, { recursive: true });
  } catch {
    /* already gone */
  }
}

export async function deleteStemPcm(songId: string, stemId: string): Promise<void> {
  try {
    const dir = await songDir(songId);
    await dir.removeEntry(`${stemId}.pcm`);
  } catch {
    /* already gone */
  }
}

/** Ask the browser not to evict our data (Safari evicts after 7 days of non-use otherwise). */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
