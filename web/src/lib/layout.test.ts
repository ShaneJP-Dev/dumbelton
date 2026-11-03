import { describe, expect, it } from 'vitest';
import { arrangementLayout, displayFrame, songLayout, sourceAt } from './layout';
import type { Project } from './types';

const project = {
  lengthFrames: 1000,
  sections: [
    { id: 'v', kind: 'verse', name: 'Verse', start: 0, end: 400 },
    { id: 'c', kind: 'chorus', name: 'Chorus', start: 400, end: 700 },
    { id: 'b', kind: 'bridge', name: 'Bridge', start: 700, end: 1000 },
  ],
} as unknown as Project;

describe('timeline layout', () => {
  it('lays an arrangement end to end and drops removed sections', () => {
    const arr = { id: 'a', name: 'A', items: [{ id: '1', sectionId: 'c' }, { id: '2', sectionId: 'v' }, { id: '3', sectionId: 'c' }] };
    const l = arrangementLayout(project, arr);
    expect(l.arranged).toBe(true);
    expect(l.clips.map((c) => [c.section?.name, c.offset])).toEqual([
      ['Chorus', 0],
      ['Verse', 300],
      ['Chorus', 700],
    ]);
    expect(l.length).toBe(1000);
    // Bridge is not in the arrangement, so it is not on the timeline
    expect(l.clips.some((c) => c.section?.id === 'b')).toBe(false);
  });

  it('maps between source frames and the displayed timeline', () => {
    const arr = { id: 'a', name: 'A', items: [{ id: '1', sectionId: 'c' }, { id: '2', sectionId: 'v' }] };
    const l = arrangementLayout(project, arr);
    expect(displayFrame(l, 450, 0)).toBe(50);
    expect(displayFrame(l, 100, 1)).toBe(400);
    expect(displayFrame(l, 380, 0)).toBe(0); // crossfade pre-roll before the clip clamps to its start
    expect(sourceAt(l, 50)).toEqual({ index: 0, frame: 450 });
    expect(sourceAt(l, 450)).toEqual({ index: 1, frame: 150 });
    expect(displayFrame(songLayout(project), 123, 0)).toBe(123);
  });
});
