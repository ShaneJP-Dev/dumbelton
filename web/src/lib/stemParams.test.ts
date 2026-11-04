import { describe, expect, it } from 'vitest';
import { stemParams } from './stemParams';
import type { Project } from './types';

const p = {
  stems: [
    { id: 'a', gain: 1, pan: 0, muted: true, solo: false },
    { id: 'b', gain: 0.5, pan: 0, muted: false, solo: true },
    { id: 'c', gain: 1, pan: 0, muted: false, solo: false },
  ],
} as unknown as Project;

describe('stemParams', () => {
  it('Practice and Arrange use the song’s mutes and solos', () => {
    expect(stemParams(p, 'practice', ['c']).map((s) => [s.mute, s.solo])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  it('Live ignores them: nothing muted or soloed except tracks muted on the Live screen', () => {
    expect(stemParams(p, 'live', []).map((s) => [s.mute, s.solo])).toEqual([
      [false, false],
      [false, false],
      [false, false],
    ]);
    expect(stemParams(p, 'live', ['c']).map((s) => s.mute)).toEqual([false, false, true]);
    expect(stemParams(p, 'live', []).map((s) => s.gain)).toEqual([1, 0.5, 1]); // volumes still apply
  });
});
