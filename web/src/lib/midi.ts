/**
 * MIDI pedals and pads: reading messages and matching them to app actions.
 * Pure (no Web MIDI here) so it can be tested; state/midi.ts does the I/O.
 */

export type MidiKind = 'note' | 'cc' | 'pc';

/** What a pedal or pad sends, regardless of pressed or released. Channel is 1–16. */
export interface MidiTrigger {
  kind: MidiKind;
  channel: number;
  number: number;
}

export interface MidiEvent extends MidiTrigger {
  /** Pressed (note on, CC ≥ 64, program change) or released (note off, CC < 64). */
  press: boolean;
  /** Program changes have no release. */
  hasRelease: boolean;
}

/** Decode one MIDI message; null for anything that isn't a note, CC or program change. */
export function parseMidi(data: ArrayLike<number>): MidiEvent | null {
  if (data.length < 2) return null;
  const type = data[0] & 0xf0;
  const channel = (data[0] & 0x0f) + 1;
  const number = data[1] & 0x7f;
  const value = (data[2] ?? 0) & 0x7f;
  switch (type) {
    case 0x90:
      return { kind: 'note', channel, number, press: value > 0, hasRelease: true };
    case 0x80:
      return { kind: 'note', channel, number, press: false, hasRelease: true };
    case 0xb0:
      return { kind: 'cc', channel, number, press: value >= 64, hasRelease: true };
    case 0xc0:
      return { kind: 'pc', channel, number, press: true, hasRelease: false };
    default:
      return null;
  }
}

export function triggerKey(t: MidiTrigger): string {
  return `${t.kind}:${t.channel}:${t.number}`;
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** "Note C4 · ch 1", "CC 64 · ch 1", "Program 3 · ch 10". */
export function describeTrigger(t: MidiTrigger): string {
  const what =
    t.kind === 'note' ? `Note ${NOTES[t.number % 12]}${Math.floor(t.number / 12) - 1}` : t.kind === 'cc' ? `CC ${t.number}` : `Program ${t.number + 1}`;
  return `${what} · ch ${t.channel}`;
}

/** An app action a pedal can trigger. Group mutes are "group:<Outputs group id>". */
export type MidiAction = string;

export interface ActionInfo {
  id: MidiAction;
  label: string;
}

/** Every action, in the order the Controls page lists them. */
export function midiActions(groups: { id: string; name: string }[]): ActionInfo[] {
  return [
    { id: 'play', label: 'Play / stop' },
    { id: 'next-section', label: 'Next section' },
    { id: 'prev-section', label: 'Previous section' },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `section-${i + 1}`, label: `Section ${i + 1}` })),
    { id: 'next-song', label: 'Next song' },
    { id: 'prev-song', label: 'Previous song' },
    { id: 'repeat', label: 'Repeat on / off' },
    { id: 'cues', label: 'Spoken cues on / off' },
    { id: 'mute-all', label: 'Mute all (hold 2 s) / unmute' },
    { id: 'unmute-all', label: 'Unmute everything' },
    ...groups.map((g) => ({ id: `group:${g.id}`, label: `Mute ${g.name} on / off` })),
  ];
}

/** Which pedal does what: one trigger per action. */
export type MidiMap = Record<MidiAction, MidiTrigger>;

/** Give `action` this trigger, taking it away from any other action. */
export function assign(map: MidiMap, action: MidiAction, t: MidiTrigger): MidiMap {
  const key = triggerKey(t);
  const next: MidiMap = {};
  for (const [a, tr] of Object.entries(map)) if (triggerKey(tr) !== key && a !== action) next[a] = tr;
  next[action] = { kind: t.kind, channel: t.channel, number: t.number };
  return next;
}

export function actionFor(map: MidiMap, ev: MidiTrigger): MidiAction | null {
  const key = triggerKey(ev);
  for (const [a, tr] of Object.entries(map)) if (triggerKey(tr) === key) return a;
  return null;
}

const KEY = 'musical.midi';

export function loadMidiMap(): MidiMap {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Partial<MidiTrigger>>;
    const map: MidiMap = {};
    for (const [a, t] of Object.entries(raw)) {
      if ((t.kind === 'note' || t.kind === 'cc' || t.kind === 'pc') && typeof t.channel === 'number' && typeof t.number === 'number') {
        map[a] = { kind: t.kind, channel: t.channel, number: t.number };
      }
    }
    return map;
  } catch {
    return {};
  }
}

export function saveMidiMap(map: MidiMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}
