import type { Project, Setlist, Stem } from './types';

/**
 * Backup file layout (a TAR archive):
 *   manifest.json                 songs (sections, arrangements, volumes…) and setlists
 *   songs/<songId>/<stemId>.pcm   each track's audio, exactly as stored in the browser
 *   peaks/<stemId>/<level>.bin    waveform overviews
 */
export const BACKUP_APP = 'musical';
export const BACKUP_VERSION = 1;

type WireStem = Omit<Stem, 'present'> & { present: number[] };
export type WireProject = Omit<Project, 'stems'> & { stems: WireStem[] };

export interface BackupManifest {
  app: string;
  version: number;
  createdAt: number;
  projects: WireProject[];
  setlists: Setlist[];
}

export const MANIFEST_PATH = 'manifest.json';
export const pcmPath = (songId: string, stemId: string) => `songs/${songId}/${stemId}.pcm`;
export const peaksPath = (stemId: string, level: number) => `peaks/${stemId}/${level}.bin`;

export type BackupEntry =
  | { kind: 'manifest' }
  | { kind: 'pcm'; songId: string; stemId: string }
  | { kind: 'peaks'; stemId: string; level: number }
  | { kind: 'other' };

export function parseBackupPath(name: string): BackupEntry {
  if (name === MANIFEST_PATH) return { kind: 'manifest' };
  let m = name.match(/^songs\/([^/]+)\/([^/]+)\.pcm$/);
  if (m) return { kind: 'pcm', songId: m[1], stemId: m[2] };
  m = name.match(/^peaks\/([^/]+)\/(\d+)\.bin$/);
  if (m) return { kind: 'peaks', stemId: m[1], level: Number(m[2]) };
  return { kind: 'other' };
}

export function encodeManifest(projects: Project[], setlists: Setlist[], now = Date.now()): Uint8Array {
  const manifest: BackupManifest = {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    createdAt: now,
    projects: projects.map((p) => ({ ...p, stems: p.stems.map((s) => ({ ...s, present: Array.from(s.present) })) })),
    setlists,
  };
  return new TextEncoder().encode(JSON.stringify(manifest));
}

export function decodeManifest(bytes: Uint8Array): { projects: Project[]; setlists: Setlist[]; createdAt: number } {
  let m: BackupManifest;
  try {
    m = JSON.parse(new TextDecoder().decode(bytes)) as BackupManifest;
  } catch {
    throw new Error('This backup is damaged (its song list could not be read).');
  }
  if (m.app !== BACKUP_APP) throw new Error('This file is not a song backup from this app.');
  if (m.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of the app. Update the app first.');
  const projects = (m.projects ?? []).map((p) => ({
    ...p,
    sections: p.sections ?? [],
    arrangements: p.arrangements ?? [],
    beats: p.beats ?? [],
    downbeats: p.downbeats ?? [],
    stems: p.stems.map((s) => ({ ...s, present: Uint8Array.from(s.present ?? []) })),
  })) as Project[];
  return { projects, setlists: m.setlists ?? [], createdAt: m.createdAt };
}

/** Setlists to add: new ones only, with entries for songs that exist after the restore. */
export function setlistsToRestore(incoming: Setlist[], existingSetlistIds: Set<string>, songIds: Set<string>): Setlist[] {
  return incoming
    .filter((sl) => !existingSetlistIds.has(sl.id))
    .map((sl) => ({ ...sl, entries: sl.entries.filter((e) => songIds.has(e.projectId)) }))
    .filter((sl) => sl.entries.length > 0);
}

export function backupFileName(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Musical backup ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.tar`;
}
