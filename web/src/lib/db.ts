import Dexie, { type Table } from 'dexie';
import type { PeaksRecord, Project, Setlist } from './types';

export class MusicalDB extends Dexie {
  projects!: Table<Project, string>;
  peaks!: Table<PeaksRecord, string>;
  setlists!: Table<Setlist, string>;
  kv!: Table<{ key: string; value: unknown }, string>;

  constructor(name = 'musical') {
    super(name);
    this.version(1).stores({
      projects: 'id, updatedAt',
      peaks: 'stemId, songId',
      setlists: 'id, updatedAt',
      kv: 'key',
    });
  }
}

export const db = new MusicalDB();

export async function getKV<T>(key: string): Promise<T | undefined> {
  return (await db.kv.get(key))?.value as T | undefined;
}

export async function setKV(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}
