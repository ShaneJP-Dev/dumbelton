import { stereoRouting, type Dest, type Monitor, type Routing } from '../audio/core/types';

/**
 * Output setup for a multi-channel sound card (e.g. Dante Virtual Soundcard).
 * The desk's channel layout is fixed for the church, but every song has
 * different tracks, so tracks are routed to groups by their names.
 * Channel numbers here are 1-based, as on the desk.
 */
export interface OutputGroup {
  id: string;
  name: string;
  /** Matched against track names, case-insensitively. Words of 3 letters or fewer must start a word ("ag" matches "AG 1", not "Stage"). */
  keywords: string[];
  /** First channel (1-based). */
  first: number;
  /** Two channels (L/R) or one (stereo tracks are summed). */
  stereo: boolean;
  /** The app's own click and count-in go to this group. */
  click?: boolean;
  /** Left out of the stereo mix (click, guide). */
  notInMix?: boolean;
}

export interface OutputSetup {
  mode: 'stereo' | 'multitrack';
  /** Output device id ('' = system default). */
  deviceId: string;
  groups: OutputGroup[];
  /** Optional stereo mix of all tracks except click/guide, e.g. for recording or a backup feed. */
  mix: { enabled: boolean; first: number };
}

export const FALLBACK_GROUP = 'other';

export const DEFAULT_GROUPS: OutputGroup[] = [
  { id: 'click', name: 'Click', keywords: ['click', 'metronome', 'count'], first: 1, stereo: false, click: true, notInMix: true },
  { id: 'guide', name: 'Guide', keywords: ['guide', 'cue', 'cues'], first: 2, stereo: false, notInMix: true },
  { id: 'drums', name: 'Drums', keywords: ['drum', 'kick', 'snare', 'perc', 'hat', 'tom', 'loop', 'cymbal', 'overhead'], first: 3, stereo: true },
  { id: 'bass', name: 'Bass', keywords: ['bass', 'sub', '808'], first: 5, stereo: false },
  { id: 'keys', name: 'Keys', keywords: ['key', 'piano', 'rhodes', 'organ', 'synth', 'pad', 'wurli'], first: 6, stereo: true },
  { id: 'guitars', name: 'Guitars', keywords: ['gtr', 'guitar', 'ag', 'eg'], first: 8, stereo: true },
  { id: 'vocals', name: 'Vocals', keywords: ['vox', 'vocal', 'voice', 'bgv', 'choir', 'harmony'], first: 10, stereo: true },
  { id: FALLBACK_GROUP, name: 'Other', keywords: [], first: 12, stereo: true },
];

export function defaultSetup(): OutputSetup {
  return {
    mode: 'stereo',
    deviceId: '',
    groups: DEFAULT_GROUPS.map((g) => ({ ...g, keywords: [...g.keywords] })),
    mix: { enabled: false, first: 15 },
  };
}

function words(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function matchesKeyword(name: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return false;
  if (k.length <= 3) return words(name).some((w) => w.startsWith(k));
  return name.toLowerCase().includes(k);
}

/** The group a track goes to: its pinned group, else the first group whose keywords match its name, else "Other". */
export function groupForStem(setup: OutputSetup, stem: { name: string; output?: string }): OutputGroup {
  const groups = setup.groups;
  if (stem.output) {
    const pinned = groups.find((g) => g.id === stem.output);
    if (pinned) return pinned;
  }
  const hit = groups.find((g) => g.keywords.some((k) => matchesKeyword(stem.name, k)));
  return hit ?? groups.find((g) => g.id === FALLBACK_GROUP) ?? groups[groups.length - 1];
}

/** 1-based channels of a group. */
export function groupChannels(g: { first: number; stereo: boolean }): number[] {
  return g.stereo ? [g.first, g.first + 1] : [g.first];
}

export function channelLabel(g: { first: number; stereo: boolean }): string {
  return g.stereo ? `${g.first}–${g.first + 1}` : `${g.first}`;
}

/** Engine routing (0-based channels) for a song's tracks. */
export function buildRouting(setup: OutputSetup, stems: { name: string; output?: string }[]): Routing {
  if (setup.mode === 'stereo' || setup.groups.length === 0) return stereoRouting(stems.length);
  const dest = (g: { first: number; stereo: boolean }): Dest => (g.stereo ? { l: g.first - 1, r: g.first } : { ch: g.first - 1 });
  const routing: Routing = {
    stems: stems.map((s) => {
      const g = groupForStem(setup, s);
      const d: Dest[] = [dest(g)];
      if (setup.mix.enabled && !g.notInMix) d.push(dest({ first: setup.mix.first, stereo: true }));
      return d;
    }),
    click: [],
  };
  const clickGroup = setup.groups.find((g) => g.click);
  routing.click = clickGroup ? groupChannels(clickGroup).map((c) => c - 1) : [0];
  // the app's spoken cues go where the song's guide track would
  const guideGroup = setup.groups.find((g) => g.id === 'guide');
  routing.cue = guideGroup ? groupChannels(guideGroup).map((c) => c - 1) : routing.click;
  return routing;
}

/** One channel strip on the Desk panel (channels are 1-based, as on the desk). */
export interface DeskChannel {
  ch: number;
  label: string;
  kind: 'click' | 'guide' | 'group' | 'mix';
  tracks: string[];
  /** Things the app itself adds (its click, spoken cues). */
  extras: string[];
}

/** What each output channel carries, in channel order: the strips of the Desk panel. */
export function deskChannels(setup: OutputSetup, stems: { name: string; output?: string }[]): DeskChannel[] {
  if (setup.mode === 'stereo' || setup.groups.length === 0) {
    const all = stems.map((s) => s.name);
    return [
      { ch: 1, label: 'Main L', kind: 'mix', tracks: all, extras: ['Click', 'Spoken cues'] },
      { ch: 2, label: 'Main R', kind: 'mix', tracks: all, extras: ['Click', 'Spoken cues'] },
    ];
  }
  const byCh = new Map<number, DeskChannel>();
  const add = (ch: number, label: string, kind: DeskChannel['kind'], tracks: string[], extras: string[]) => {
    const had = byCh.get(ch);
    if (had) {
      // two groups on one channel (the Outputs page warns about it): show both
      had.label = `${had.label} + ${label}`;
      had.tracks.push(...tracks);
      had.extras.push(...extras);
    } else byCh.set(ch, { ch, label, kind, tracks: [...tracks], extras: [...extras] });
  };
  for (const g of setup.groups) {
    const tracks = stems.filter((s) => groupForStem(setup, s).id === g.id).map((s) => s.name);
    const kind: DeskChannel['kind'] = g.click ? 'click' : g.id === 'guide' ? 'guide' : 'group';
    const extras = [...(g.click ? ['App click'] : []), ...(g.id === 'guide' ? ['Spoken cues'] : [])];
    groupChannels(g).forEach((ch, i) => add(ch, g.stereo ? `${g.name} ${i ? 'R' : 'L'}` : g.name, kind, tracks, extras));
  }
  if (setup.mix.enabled) {
    const inMix = stems.filter((s) => !groupForStem(setup, s).notInMix).map((s) => s.name);
    add(setup.mix.first, 'Mix L', 'mix', inMix, []);
    add(setup.mix.first + 1, 'Mix R', 'mix', inMix, []);
  }
  return [...byCh.values()].filter((c) => c.ch >= 1 && c.ch <= 32).sort((a, b) => a.ch - b.ch);
}

/**
 * What a 2-channel device (a laptop) should play. With a multichannel layout it
 * would only get channels 1-2 (Click and Guide), so it plays the full mix, or
 * the channel being listened to on the Desk panel. Never on a real
 * multichannel device: there, outputs 1-2 are the desk's own channels.
 */
export function monitorFor(setup: OutputSetup, deviceChannels: number, listen: number | null): Monitor | null {
  if (setup.mode !== 'multitrack' || deviceChannels > 2) return null;
  return listen === null ? { kind: 'mix' } : { kind: 'channel', ch: listen - 1 };
}

/** Problems to show next to the setup: channels the device lacks, channels used twice. */
export function channelProblems(setup: OutputSetup, available: number): string[] {
  if (setup.mode === 'stereo') return [];
  if (available <= 2) {
    return [
      `This output only has ${available} channel${available === 1 ? '' : 's'}, so it plays the full mix, and the Desk panel on the song screen shows what each channel gets. At church, choose Dante Virtual Soundcard (or another multi-channel output) above.`,
    ];
  }
  const out: string[] = [];
  const used = new Map<number, string>();
  const entries = [
    ...setup.groups.map((g) => ({ name: g.name, chans: groupChannels(g) })),
    ...(setup.mix.enabled ? [{ name: 'Stereo mix', chans: [setup.mix.first, setup.mix.first + 1] }] : []),
  ];
  for (const e of entries) {
    const missing = e.chans.filter((c) => c > available);
    if (missing.length) {
      const list = missing.length === 2 ? `channels ${missing[0]}–${missing[1]}` : `channel ${missing[0]}`;
      out.push(`${e.name} uses ${list}, but this output only has ${available}.`);
    }
    for (const c of e.chans) {
      if (c < 1) out.push(`${e.name}: channel ${c} is not valid.`);
      const prev = used.get(c);
      if (prev && prev !== e.name) out.push(`Channel ${c} is used by both ${prev} and ${e.name}.`);
      used.set(c, e.name);
    }
  }
  return [...new Set(out)];
}

const KEY = 'musical.outputs';

export function loadSetup(): OutputSetup {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<OutputSetup>;
      const d = defaultSetup();
      return {
        mode: s.mode === 'multitrack' ? 'multitrack' : 'stereo',
        deviceId: typeof s.deviceId === 'string' ? s.deviceId : '',
        groups: Array.isArray(s.groups) && s.groups.length ? s.groups : d.groups,
        mix: s.mix && typeof s.mix.first === 'number' ? { enabled: !!s.mix.enabled, first: s.mix.first } : d.mix,
      };
    }
  } catch {
    /* fall back to defaults */
  }
  return defaultSetup();
}

export function saveSetup(s: OutputSetup): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
