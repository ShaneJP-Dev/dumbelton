import { describe, expect, it } from 'vitest';
import { defaultSetup, groupForStem } from './outputs';
import { clickAudible, liveMuteReason, NO_LIVE_MUTES, stemParams, type LiveMutes } from './stemParams';
import type { Project, Stem } from './types';

const p = {
  stems: [
    { id: 'a', name: 'Kick', gain: 1, pan: 0, muted: true, solo: false },
    { id: 'b', name: 'Snare', gain: 0.5, pan: 0, muted: false, solo: true },
    { id: 'c', name: 'Bass', gain: 1, pan: 0, muted: false, solo: false },
    { id: 'd', name: 'Click', gain: 1, pan: 0, muted: false, solo: false },
    { id: 'e', name: 'Shaker', gain: 1, pan: 0, muted: false, solo: false, output: 'drums' },
  ],
} as unknown as Project;

const setup = defaultSetup();
const groupOf = (s: Stem) => groupForStem(setup, s).id;
const live = (m: Partial<LiveMutes>): LiveMutes => ({ ...NO_LIVE_MUTES, ...m });
const mutes = (m: Partial<LiveMutes>) => stemParams(p, 'live', live(m), groupOf).map((s) => s.mute);

describe('stemParams', () => {
  it('Practice and Arrange use the song’s mutes and solos, whatever Live has muted', () => {
    expect(stemParams(p, 'practice', live({ tracks: ['c'], groups: ['drums'], all: true }), groupOf).map((s) => [s.mute, s.solo])).toEqual([
      [true, false],
      [false, true],
      [false, false],
      [false, false],
      [false, false],
    ]);
  });

  it('Live ignores them: nothing muted or soloed until something is muted on the Live screen', () => {
    expect(stemParams(p, 'live', NO_LIVE_MUTES, groupOf).map((s) => [s.mute, s.solo])).toEqual([
      [false, false],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
    ]);
    expect(stemParams(p, 'live', NO_LIVE_MUTES, groupOf).map((s) => s.gain)).toEqual([1, 0.5, 1, 1, 1]); // volumes still apply
  });

  it('a single track mutes on its own', () => {
    expect(mutes({ tracks: ['c'] })).toEqual([false, false, true, false, false]);
  });

  it('a group mutes every track the Outputs screen puts in it (by name, or pinned)', () => {
    expect(mutes({ groups: ['drums'] })).toEqual([true, true, false, false, true]);
    expect(mutes({ groups: ['click'] })).toEqual([false, false, false, true, false]);
  });

  it('groups follow the Outputs setup when it changes', () => {
    // the user adds "snare" to Bass on the Outputs screen and moves Bass above Drums
    const custom = defaultSetup();
    const bass = custom.groups.find((g) => g.id === 'bass')!;
    bass.keywords.push('snare');
    custom.groups = [bass, ...custom.groups.filter((g) => g !== bass)];
    const of = (s: Stem) => groupForStem(custom, s).id;
    expect(stemParams(p, 'live', live({ groups: ['bass'] }), of).map((s) => s.mute)).toEqual([false, true, true, false, false]);
  });

  it('mute all silences everything; unmuting it leaves the other mutes as they were', () => {
    expect(mutes({ all: true })).toEqual([true, true, true, true, true]);
    expect(mutes({ all: false, groups: ['drums'] })).toEqual([true, true, false, false, true]);
  });

  it('liveMuteReason says why a track is silent', () => {
    const [kick, , bass] = p.stems;
    expect(liveMuteReason(kick, live({ tracks: ['a'], groups: ['drums'], all: true }), groupOf)).toBe('track');
    expect(liveMuteReason(kick, live({ groups: ['drums'], all: true }), groupOf)).toBe('group');
    expect(liveMuteReason(bass, live({ groups: ['drums'], all: true }), groupOf)).toBe('all');
    expect(liveMuteReason(bass, live({ groups: ['drums'] }), groupOf)).toBeNull();
  });
});

describe('clickAudible', () => {
  it('the click plays when it is on, except in Live with mute all or its group muted', () => {
    expect(clickAudible(false, 'live', NO_LIVE_MUTES, 'click')).toBe(false);
    expect(clickAudible(true, 'live', NO_LIVE_MUTES, 'click')).toBe(true);
    expect(clickAudible(true, 'live', live({ all: true }), 'click')).toBe(false);
    expect(clickAudible(true, 'live', live({ groups: ['click'] }), 'click')).toBe(false);
    expect(clickAudible(true, 'live', live({ groups: ['drums'] }), 'click')).toBe(true);
    expect(clickAudible(true, 'practice', live({ all: true, groups: ['click'] }), 'click')).toBe(true);
    expect(clickAudible(true, 'live', live({ groups: ['click'] }), null)).toBe(true);
  });
});
