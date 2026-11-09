import { actionFor, assign, describeTrigger, parseMidi, saveMidiMap, triggerKey, type MidiAction, type MidiEvent } from '../lib/midi';
import { LIVE_MUTE_ALL_HOLD_MS } from '../lib/stemParams';
import { setCuesEnabled, setLiveMuteAll, setLiveRepeat, toggleLiveGroup, togglePlay, unmuteEverything } from './actions';
import { jumpToSection, stepSection } from './controls';
import { nextSong } from './live';
import { getState, setState } from './store';

/**
 * MIDI pedals and pads through Web MIDI (Chrome and Edge; not Safari).
 * Messages are matched to actions with the map learned on the Controls page.
 */

interface InputLike {
  id: string;
  name?: string | null;
  state?: string;
  onmidimessage: ((e: { data: Uint8Array | null }) => void) | null;
}
interface AccessLike {
  inputs: Map<string, InputLike> | { forEach(cb: (i: InputLike) => void): void };
  onstatechange: ((e: unknown) => void) | null;
}

const ENABLED = 'musical.midi.on';
let access: AccessLike | null = null;
/** Pressed state per pedal, so a CC pedal that repeats its value acts once. */
const held = new Map<string, boolean>();
let muteAllTimer: ReturnType<typeof setTimeout> | null = null;

export function midiSupported(): boolean {
  return typeof (navigator as Navigator & { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function';
}

function attach(): void {
  if (!access) return;
  const names: string[] = [];
  access.inputs.forEach((input) => {
    input.onmidimessage = (e) => e.data && onMidiMessage(e.data);
    if (input.state !== 'disconnected') names.push(input.name || 'MIDI input');
  });
  setState({ midi: { status: 'on', inputs: names } });
}

/** Ask the browser for MIDI and listen to every input (also ones plugged in later). */
export async function connectMidi(): Promise<void> {
  if (!midiSupported()) {
    setState({ midi: { status: 'unsupported', inputs: [] } });
    return;
  }
  setState({ midi: { status: 'connecting', inputs: [] } });
  try {
    const nav = navigator as unknown as { requestMIDIAccess(o?: { sysex: boolean }): Promise<AccessLike> };
    access = await nav.requestMIDIAccess({ sysex: false });
    access.onstatechange = () => attach();
    attach();
    try {
      localStorage.setItem(ENABLED, '1');
    } catch {
      /* storage unavailable */
    }
  } catch (err) {
    setState({ midi: { status: 'denied', inputs: [], message: String((err as Error).message ?? err) } });
  }
}

/** Reconnect at start-up if MIDI was used before in this browser. */
export function autoConnectMidi(): void {
  let on = false;
  try {
    on = localStorage.getItem(ENABLED) === '1';
  } catch {
    /* storage unavailable */
  }
  if (on && midiSupported()) void connectMidi();
}

/** Wait for the next pedal press and give it to `action` (null cancels). */
export function learnMidi(action: MidiAction | null): void {
  setState({ midiLearn: action });
}

export function clearMidi(action: MidiAction): void {
  const map = { ...getState().midiMap };
  delete map[action];
  saveMidiMap(map);
  setState({ midiMap: map });
}

export function onMidiMessage(data: ArrayLike<number>): void {
  const ev = parseMidi(data);
  if (!ev) return;
  setState({ midiLast: `${describeTrigger(ev)}${ev.hasRelease ? (ev.press ? ' · pressed' : ' · released') : ''}` });
  if (ev.hasRelease) {
    const key = triggerKey(ev);
    if ((held.get(key) ?? false) === ev.press) return; // only changes count
    held.set(key, ev.press);
  }
  const { midiLearn, midiMap } = getState();
  if (midiLearn) {
    if (!ev.press) return;
    const map = assign(midiMap, midiLearn, ev);
    saveMidiMap(map);
    setState({ midiMap: map, midiLearn: null });
    return;
  }
  const action = actionFor(midiMap, ev);
  if (action) run(action, ev);
}

function stopMuteAllTimer(): void {
  if (muteAllTimer !== null) clearTimeout(muteAllTimer);
  muteAllTimer = null;
}

/** Mute all keeps the screen's rule: hold 2 s to mute (a pedal without a release acts at once), press to unmute. */
function muteAll(ev: MidiEvent): void {
  if (getState().mode !== 'live') return;
  if (!ev.press) {
    stopMuteAllTimer();
    return;
  }
  if (getState().liveMuteAll) {
    setLiveMuteAll(false);
    return;
  }
  if (!ev.hasRelease) {
    setLiveMuteAll(true);
    return;
  }
  stopMuteAllTimer();
  muteAllTimer = setTimeout(() => {
    muteAllTimer = null;
    setLiveMuteAll(true);
  }, LIVE_MUTE_ALL_HOLD_MS);
}

function run(action: MidiAction, ev: MidiEvent): void {
  if (action === 'mute-all') return muteAll(ev);
  if (!ev.press) return;
  const { current, mode } = getState();
  if (!current) return;
  const live = mode === 'live';
  if (action === 'play') void togglePlay();
  else if (action === 'next-section') stepSection(1);
  else if (action === 'prev-section') stepSection(-1);
  else if (action.startsWith('section-')) jumpToSection(Number(action.slice(8)) - 1);
  else if (action === 'next-song') nextSong(1);
  else if (action === 'prev-song') nextSong(-1);
  else if (action === 'repeat' && live) setLiveRepeat(!getState().liveRepeat);
  else if (action === 'cues') setCuesEnabled(!getState().cues);
  else if (action === 'unmute-all' && live) unmuteEverything();
  else if (action.startsWith('group:') && live) toggleLiveGroup(action.slice(6));
}
