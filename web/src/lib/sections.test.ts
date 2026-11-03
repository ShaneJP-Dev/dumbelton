import { describe, expect, it } from 'vitest';
import {
  mergeWithNext,
  moveBoundary,
  removeSection,
  renameSection,
  renumber,
  sectionIndexAt,
  sectionsFromAnalysis,
  setKind,
  snapFrame,
  splitAt,
  shortName,
} from './sections';
import type { Section } from './types';

const S = (kind: Section['kind'], start: number, end: number, id = `${kind}${start}`): Section => ({
  id,
  kind,
  name: '',
  start,
  end,
});

describe('sections', () => {
  it('numbers repeated kinds only', () => {
    const out = renumber([S('intro', 0, 1), S('verse', 1, 2), S('chorus', 2, 3), S('verse', 3, 4)]);
    expect(out.map((s) => s.name)).toEqual(['Intro', 'Verse 1', 'Chorus', 'Verse 2']);
  });

  it('converts analyzer seconds to contiguous frames', () => {
    const out = sectionsFromAnalysis(
      [
        { start: 0, end: 8.01, label: 'intro' },
        { start: 8.01, end: 24, label: 'chorus' },
        { start: 24, end: 30, label: 'mystery' },
      ],
      48000 * 31,
      48000,
    );
    expect(out.map((s) => [s.kind, s.start, s.end])).toEqual([
      ['intro', 0, 384480],
      ['chorus', 384480, 1152000],
      ['inst', 1152000, 48000 * 31],
    ]);
  });

  it('finds the section at a frame', () => {
    const secs = [S('intro', 0, 100), S('verse', 100, 200), S('chorus', 200, 300)];
    expect(sectionIndexAt(secs, 0)).toBe(0);
    expect(sectionIndexAt(secs, 150)).toBe(1);
    expect(sectionIndexAt(secs, 299)).toBe(2);
  });

  it('snaps to bars and beats', () => {
    const beats = [0, 10, 20, 30, 40];
    const downbeats = [0, 40];
    expect(snapFrame(14, 'beat', beats, downbeats)).toBe(10);
    expect(snapFrame(24, 'bar', beats, downbeats)).toBe(40);
    expect(snapFrame(24.4, 'off', beats, downbeats)).toBe(24);
  });

  it('moves a shared boundary, respecting a minimum length', () => {
    const secs = [S('intro', 0, 100), S('verse', 100, 200)];
    expect(moveBoundary(secs, 1, 150, 10).map((s) => [s.start, s.end])).toEqual([
      [0, 150],
      [150, 200],
    ]);
    expect(moveBoundary(secs, 1, 199, 10)[0].end).toBe(190);
  });

  it('splits, merges and removes', () => {
    let secs = renumber([S('verse', 0, 100), S('chorus', 100, 200)]);
    secs = splitAt(secs, 50, 10);
    expect(secs.map((s) => s.name)).toEqual(['Verse 1', 'Verse 2', 'Chorus']);
    expect(splitAt(secs, 52, 10)).toBe(secs); // too close to an edge -> unchanged
    secs = mergeWithNext(secs, 0);
    expect(secs.map((s) => [s.name, s.start, s.end])).toEqual([
      ['Verse', 0, 100],
      ['Chorus', 100, 200],
    ]);
    secs = removeSection(secs, 1);
    expect(secs.map((s) => [s.kind, s.start, s.end])).toEqual([['verse', 0, 200]]);
  });

  it('keeps custom names through renumbering', () => {
    let secs = renumber([S('verse', 0, 100), S('verse', 100, 200)]);
    secs = renameSection(secs, 0, 'Tag');
    secs = setKind(secs, 1, 'chorus');
    expect(secs.map((s) => s.name)).toEqual(['Tag', 'Chorus']);
  });
});

describe('shortName', () => {
  it('abbreviates section names for narrow blocks', () => {
    expect(shortName('Verse 1')).toBe('V1');
    expect(shortName('Chorus')).toBe('C');
    expect(shortName('Pre-Chorus 2')).toBe('PC2');
    expect(shortName('Instrumental 3')).toBe('In3');
  });
});
