import { describe, expect, it } from 'vitest';
import {
  assignTrackChannels,
  buildRouting,
  channelList,
  channelProblems,
  defaultSetup,
  deskChannels,
  groupForStem,
  loadSetup,
  matchesKeyword,
  monitorFor,
  trackKey,
  type OutputSetup,
} from './outputs';

/** Multitrack with the shared-group layout (the original church layout). */
const multi = (): OutputSetup => ({ ...defaultSetup(), mode: 'multitrack', layout: 'groups' });
/** Multitrack with one channel per track (the default). */
const perTrack = (): OutputSetup => ({ ...defaultSetup(), mode: 'multitrack' });
const g = (name: string, output?: string) => groupForStem(multi(), { name, output }).name;

describe('output groups', () => {
  it('routes tracks by name', () => {
    expect(g('Click')).toBe('Click');
    expect(g('Count In')).toBe('Click');
    expect(g('Guide')).toBe('Guide');
    expect(g('Cues')).toBe('Guide');
    expect(g('Kick')).toBe('Drums');
    expect(g('Drums Loop')).toBe('Drums');
    expect(g('Synth Bass')).toBe('Bass');
    expect(g('Rhodes')).toBe('Keys');
    expect(g('Pad')).toBe('Keys');
    expect(g('AG 1')).toBe('Guitars');
    expect(g('EG Lead')).toBe('Guitars');
    expect(g('Lead Vox')).toBe('Vocals');
    expect(g('BGVs')).toBe('Vocals');
    expect(g('Strings')).toBe('Other');
    expect(g('Stage FX')).toBe('Other'); // "ag" only matches at the start of a word
  });

  it('a pinned group wins over the name', () => {
    expect(g('Strings', 'keys')).toBe('Keys');
    expect(g('Strings', 'gone')).toBe('Other'); // pinned group was deleted
  });

  it('matches short keywords on word starts only', () => {
    expect(matchesKeyword('808 Sub', 'sub')).toBe(true);
    expect(matchesKeyword('Subtle Pad', 'sub')).toBe(true);
    expect(matchesKeyword('Sustain', 'sub')).toBe(false);
    expect(matchesKeyword('KeysLeft', 'key')).toBe(true);
  });
});

describe('buildRouting', () => {
  const stems = [{ name: 'Click' }, { name: 'Guide' }, { name: 'Drums' }, { name: 'Bass' }, { name: 'Keys' }];

  it('stereo mode puts everything on 1-2', () => {
    const r = buildRouting(defaultSetup(), stems);
    expect(r.stems.every((d) => d.length === 1 && 'l' in d[0] && d[0].l === 0 && d[0].r === 1)).toBe(true);
    expect(r.click).toEqual([0, 1]);
    expect(r.cue).toEqual([0, 1]);
  });

  it('multitrack mode uses the church layout (0-based in the engine)', () => {
    const r = buildRouting(multi(), stems);
    expect(r.stems).toEqual([[{ ch: 0 }], [{ ch: 1 }], [{ l: 2, r: 3 }], [{ ch: 4 }], [{ l: 5, r: 6 }]]);
    expect(r.click).toEqual([0]);
    expect(r.cue).toEqual([1]); // spoken cues on the Guide channel
  });

  it('the optional stereo mix gets every track except click and guide', () => {
    const s = multi();
    s.mix = { enabled: true, first: 15 };
    const r = buildRouting(s, stems);
    expect(r.stems[0]).toEqual([{ ch: 0 }]);
    expect(r.stems[1]).toEqual([{ ch: 1 }]);
    expect(r.stems[2]).toEqual([{ l: 2, r: 3 }, { l: 14, r: 15 }]);
    expect(r.stems[3]).toEqual([{ ch: 4 }, { l: 14, r: 15 }]);
  });

  it('reports channels the output does not have, and clashes', () => {
    const s = multi();
    expect(channelProblems(s, 16)).toEqual([]);
    expect(channelProblems(s, 8)).toContain('Guitars uses channel 9, but this output only has 8.');
    expect(channelProblems(s, 8)).toContain('Vocals uses channels 10–11, but this output only has 8.');
    expect(channelProblems(s, 2)).toHaveLength(1);
    expect(channelProblems(s, 2)[0]).toMatch(/only has 2 channels, so it plays the full mix, and the Desk panel/);
    s.groups[3].first = 3; // Bass on 3, clashing with Drums 3-4
    expect(channelProblems(s, 16)).toContain('Channel 3 is used by both Drums and Bass.');
    expect(channelProblems(defaultSetup(), 2)).toEqual([]); // stereo mode: nothing to check
  });
});

describe('the Desk panel', () => {
  const stems = [{ name: 'Click' }, { name: 'Guide' }, { name: 'Drums' }, { name: 'Bass' }, { name: 'Keys' }, { name: 'Lead' }];

  it('lists the church layout channel by channel, with the tracks on each', () => {
    const d = deskChannels(multi(), stems);
    expect(d.map((c) => `${c.ch} ${c.label}`)).toEqual([
      '1 Click',
      '2 Guide',
      '3 Drums L',
      '4 Drums R',
      '5 Bass',
      '6 Keys L',
      '7 Keys R',
      '8 Guitars L',
      '9 Guitars R',
      '10 Vocals L',
      '11 Vocals R',
      '12 Other L',
      '13 Other R',
    ]);
    expect(d[2].tracks).toEqual(['Drums']);
    expect(d[11].tracks).toEqual(['Lead']);
    expect(d[0].extras).toEqual(['App click']);
    expect(d[1].extras).toEqual(['Spoken cues']);
    expect(d[7].tracks).toEqual([]); // no guitars in this song
  });

  it('adds the stereo mix pair and shows channels shared by two groups', () => {
    const s = multi();
    s.mix = { enabled: true, first: 15 };
    s.groups[3].first = 3; // Bass on 3, with Drums L
    const d = deskChannels(s, stems);
    expect(d.find((c) => c.ch === 3)!.label).toBe('Drums L + Bass');
    expect(d.find((c) => c.ch === 15)).toMatchObject({ label: 'Mix L', tracks: ['Drums', 'Bass', 'Keys', 'Lead'] });
  });

  it('in stereo mode everything is on Main L / R', () => {
    expect(deskChannels(defaultSetup(), stems).map((c) => c.label)).toEqual(['Main L', 'Main R']);
  });

  it('a laptop plays the full mix (or the channel listened to); a real multichannel device never is overridden', () => {
    expect(monitorFor(multi(), 2, null)).toEqual({ kind: 'mix' });
    expect(monitorFor(multi(), 2, 5)).toEqual({ kind: 'channel', ch: 4 });
    expect(monitorFor(multi(), 32, null)).toBeNull();
    expect(monitorFor(multi(), 32, 5)).toBeNull();
    expect(monitorFor(defaultSetup(), 2, 5)).toBeNull(); // stereo mode plays normally
  });
});

describe('one channel per track', () => {
  const songA = [{ name: 'Click' }, { name: 'Guide' }, { name: 'Kick' }, { name: 'Snare' }, { name: 'Bass' }, { name: 'Keys' }];
  const songB = [{ name: 'Click Track' }, { name: 'kick' }, { name: 'AG' }, { name: 'Bass' }, { name: 'Lead_Vox' }];

  it('is the default layout, and old saved setups move to it', () => {
    expect(defaultSetup().layout).toBe('tracks');
    // a setup saved before this layout existed (unit tests run without a browser: a stand-in storage)
    const saved = JSON.stringify({ mode: 'multitrack', groups: defaultSetup().groups });
    const g = globalThis as { localStorage?: unknown };
    const had = g.localStorage;
    g.localStorage = { getItem: () => saved, setItem: () => undefined };
    try {
      expect(loadSetup()).toMatchObject({ mode: 'multitrack', layout: 'tracks', trackChannels: [] });
    } finally {
      g.localStorage = had;
    }
  });

  it('normalises track names', () => {
    expect(trackKey('Lead_Vox')).toBe(trackKey('lead  vox'));
    expect(trackKey('EG 1')).not.toBe(trackKey('EG 2'));
  });

  it('numbers new track names from channel 3 (Click and Guide keep 1 and 2) and keeps them across songs', () => {
    const a = assignTrackChannels(perTrack(), songA)!;
    expect(a.trackChannels.map((t) => `${t.ch} ${t.name}`)).toEqual(['3 Kick', '4 Snare', '5 Bass', '6 Keys']);
    const b = assignTrackChannels(a, songB)!;
    // Kick and Bass keep theirs, the new names take the next free channels
    expect(b.trackChannels.map((t) => `${t.ch} ${t.name}`)).toEqual(['3 Kick', '4 Snare', '5 Bass', '6 Keys', '7 AG', '8 Lead_Vox']);
    expect(assignTrackChannels(b, songA)).toBeNull(); // nothing new
  });

  it('fills gaps and never takes the stereo mix pair', () => {
    const s = perTrack();
    s.mix = { enabled: true, first: 5 };
    s.trackChannels = [{ key: 'kick', name: 'Kick', ch: 4 }];
    const a = assignTrackChannels(s, [{ name: 'Snare' }, { name: 'Bass' }, { name: 'Keys' }])!;
    expect(a.trackChannels.map((t) => t.ch)).toEqual([4, 3, 7, 8]);
  });

  it('runs out after channel 32 and says so', () => {
    const many = Array.from({ length: 32 }, (_, i) => ({ name: `Track ${i + 1}` }));
    const a = assignTrackChannels(perTrack(), many)!;
    expect(a.trackChannels.filter((t) => t.ch === 0).map((t) => t.name)).toEqual(['Track 31', 'Track 32']);
    expect(channelProblems(a, 32)[0]).toMatch(/^Channels ran out: Track 31, Track 32 have no channel/);
  });

  it('routes every track to its own single channel; stereo tracks are summed', () => {
    const setup = assignTrackChannels(perTrack(), songA)!;
    const r = buildRouting(setup, [{ name: 'Keys' }, { name: 'Click' }, { name: 'Kick' }, { name: 'Guide' }, { name: 'Unknown' }]);
    expect(r.stems).toEqual([[{ ch: 5 }], [{ ch: 0 }], [{ ch: 2 }], [{ ch: 1 }], []]);
    expect(r.click).toEqual([0]);
    expect(r.cue).toEqual([1]);
    setup.mix.enabled = true;
    expect(buildRouting(setup, [{ name: 'Kick' }, { name: 'Click' }]).stems).toEqual([[{ ch: 2 }, { l: 14, r: 15 }], [{ ch: 0 }]]);
  });

  it('flags a channel used twice', () => {
    const setup = assignTrackChannels(perTrack(), songA)!;
    setup.trackChannels[1].ch = 3; // Snare onto Kick's channel
    expect(channelProblems(setup, 32)).toContain('Channel 3 is used by both Kick and Snare.');
  });

  it('the Desk panel and the channel list show the whole layout', () => {
    const setup = assignTrackChannels(assignTrackChannels(perTrack(), songA)!, songB)!;
    const d = deskChannels(setup, songB);
    expect(d.map((c) => `${c.ch} ${c.label}`)).toEqual(['1 Click', '2 Guide', '3 Kick', '4 Snare', '5 Bass', '6 Keys', '7 AG', '8 Lead_Vox']);
    expect(d[0].tracks).toEqual(['Click Track']);
    expect(d[2].tracks).toEqual(['kick']);
    expect(d[3].tracks).toEqual([]); // no snare in song B
    expect(channelList(setup)).toBe('1 Click\n2 Guide\n3 Kick\n4 Snare\n5 Bass\n6 Keys\n7 AG\n8 Lead_Vox');
  });
});
