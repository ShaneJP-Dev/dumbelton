import { describe, expect, it } from 'vitest';
import { XFADE_FRAMES } from '../audio/core/types';
import { beatFrames, fadeFrames, fadeLabel } from './fade';
import type { Project } from './types';

const at120 = { beats: Array.from({ length: 16 }, (_, i) => i * 24000) } as unknown as Project;
const noGrid = { beats: [] } as unknown as Project;

describe('transition fades', () => {
  it('measures fades in beats of the song', () => {
    expect(beatFrames(at120)).toBe(24000);
    expect(fadeFrames(at120, 0)).toBe(XFADE_FRAMES);
    expect(fadeFrames(at120, 1)).toBe(24000);
    expect(fadeFrames(at120, 4)).toBe(96000); // one bar at 120 BPM = 2 s
    expect(fadeFrames(noGrid, 2)).toBe(48000); // no grid: half a second per "beat"
  });

  it('labels the options', () => {
    expect([0, 1, 2, 4].map((b) => fadeLabel(b as 0, true))).toEqual(['Cut', '1 beat', '2 beats', '1 bar']);
    expect(fadeLabel(2, false)).toBe('1 s');
  });
});
