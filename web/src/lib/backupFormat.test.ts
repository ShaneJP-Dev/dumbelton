import { describe, expect, it } from 'vitest';
import { backupFileName, decodeManifest, encodeManifest, parseBackupPath, pcmPath, peaksPath, setlistsToRestore } from './backupFormat';
import type { Project, Setlist } from './types';

const project = {
  id: 's_1',
  name: 'Way Maker',
  createdAt: 1,
  updatedAt: 2,
  lengthFrames: 480000,
  bpm: 68,
  beats: [0, 42000],
  downbeats: [0],
  stems: [
    { id: 't_1', name: 'Drums', color: '#f00', channels: 2, length: 480000, present: Uint8Array.of(1, 0, 1, 1, 1, 1, 1, 1), bytes: 100, gain: 0.5, pan: 0, muted: true, solo: false, inAnalysisMix: true, output: 'drums' },
  ],
  sections: [{ id: 'x', kind: 'chorus', name: 'Chorus', start: 0, end: 480000 }],
  arrangements: [{ id: 'a', name: 'Short', items: [{ id: 'i', sectionId: 'x' }] }],
  analysis: { status: 'done' },
  masterGain: 0.7,
} as unknown as Project;

describe('backup format', () => {
  it('round-trips songs, including track block maps and settings', () => {
    const setlists: Setlist[] = [{ id: 'l', name: 'Sunday', createdAt: 1, updatedAt: 1, entries: [{ id: 'e', projectId: 's_1' }] }];
    const back = decodeManifest(encodeManifest([project], setlists, 123));
    expect(back.createdAt).toBe(123);
    expect(back.projects[0].stems[0].present).toBeInstanceOf(Uint8Array);
    expect(Array.from(back.projects[0].stems[0].present)).toEqual([1, 0, 1, 1, 1, 1, 1, 1]);
    expect(back.projects[0]).toEqual(project);
    expect(back.setlists).toEqual(setlists);
  });

  it('rejects other files and newer versions', () => {
    expect(() => decodeManifest(new TextEncoder().encode('not json'))).toThrow(/damaged/);
    expect(() => decodeManifest(new TextEncoder().encode('{"app":"other","version":1}'))).toThrow(/not a song backup/);
    expect(() => decodeManifest(new TextEncoder().encode('{"app":"musical","version":99,"projects":[]}'))).toThrow(/newer version/);
  });

  it('parses entry paths', () => {
    expect(parseBackupPath('manifest.json')).toEqual({ kind: 'manifest' });
    expect(parseBackupPath(pcmPath('s_1', 't_1'))).toEqual({ kind: 'pcm', songId: 's_1', stemId: 't_1' });
    expect(parseBackupPath(peaksPath('t_1', 3))).toEqual({ kind: 'peaks', stemId: 't_1', level: 3 });
    expect(parseBackupPath('._junk')).toEqual({ kind: 'other' });
  });

  it('restores only new setlists, keeping entries for songs that exist', () => {
    const incoming: Setlist[] = [
      { id: 'old', name: 'Old', createdAt: 1, updatedAt: 1, entries: [{ id: 'e1', projectId: 's_1' }] },
      { id: 'new', name: 'New', createdAt: 1, updatedAt: 1, entries: [{ id: 'e2', projectId: 's_1' }, { id: 'e3', projectId: 'gone' }] },
      { id: 'empty', name: 'Empty', createdAt: 1, updatedAt: 1, entries: [{ id: 'e4', projectId: 'gone' }] },
    ];
    const out = setlistsToRestore(incoming, new Set(['old']), new Set(['s_1']));
    expect(out.map((s) => [s.id, s.entries.map((e) => e.id)])).toEqual([['new', ['e2']]]);
  });

  it('names the file by date', () => {
    expect(backupFileName(new Date(2026, 10, 6))).toBe('Musical backup 2026-11-06.tar');
  });
});
