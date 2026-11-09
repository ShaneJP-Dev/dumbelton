import { create } from 'zustand';
import type { Quantize } from '../audio/core/types';
import type { SnapMode } from '../lib/sections';
import { loadFade, type FadeBeats } from '../lib/fade';
import { loadSetup, type OutputSetup } from '../lib/outputs';
import type { Project, Setlist } from '../lib/types';
import type { CueLang } from '../lib/voice';
import { loadMidiMap, type MidiMap } from '../lib/midi';

function loadCues(): boolean {
  try {
    return localStorage.getItem('musical.cues') !== 'off';
  } catch {
    return true;
  }
}

export type Mode = 'practice' | 'arrange' | 'live';

export type Route =
  | { name: 'library' }
  | { name: 'song'; id: string }
  | { name: 'setlists' }
  | { name: 'setlist'; id: string }
  | { name: 'outputs' }
  | { name: 'controls' };

export interface Transport {
  playing: boolean;
  segment: number;
  pending: { at: number; to: number } | null;
}

export interface AppState {
  route: Route;
  projects: Project[];
  setlists: Setlist[];
  current: Project | null;
  mode: Mode;
  speed: number;
  click: boolean;
  countIn: boolean;
  loop: boolean;
  selected: string | null;
  quantize: Exclude<Quantize, 'now'>;
  /** Fade when jumping between parts (Live) and at arrangement joins. */
  fade: FadeBeats;
  /** Multi-channel output setup (Dante etc.), saved in this browser. */
  outputs: OutputSetup;
  /** Channels the current output device takes (known once audio has started). */
  outputChannels: number | null;
  snap: SnapMode;
  arrangementId: string | null;
  transport: Transport;
  /** When playing a setlist in Live mode. */
  live: { setlistId: string; index: number } | null;
  /** Arrangement used by Live mode (from the setlist entry), or null for the song's own sections. */
  liveArrangementId: string | null;
  /** The song reached its end in Live mode (show "next song"). */
  liveEnded: boolean;
  /** Tracks muted on the Live screen (Live starts with none: "super live"). Reset for every song. */
  liveMuted: string[];
  /** Output groups muted on the Live screen (kept from song to song, like mute groups on a desk). */
  liveMutedGroups: string[];
  /** "Mute all" on the Live screen: everything silent while the song keeps playing. */
  liveMuteAll: boolean;
  /** Live "Repeat" (vamp): the current section loops until another one is tapped. */
  liveRepeat: boolean;
  /** Spoken cues in Live ("Chorus" a bar before the chorus), saved in this browser. */
  cues: boolean;
  /** The computer voice for spoken cues, fetched from the analysis server. */
  cueVoice: { status: 'idle' | 'loading' | 'ready' | 'unavailable'; lang?: CueLang; voice?: string; message?: string };
  /** MIDI pedals and pads (Web MIDI). */
  midi: { status: 'off' | 'unsupported' | 'connecting' | 'on' | 'denied'; inputs: string[]; message?: string };
  /** Which pedal does what (saved in this browser). */
  midiMap: MidiMap;
  /** The action waiting for a pedal press on the Controls page. */
  midiLearn: string | null;
  /** The last MIDI message, for the Controls page monitor. */
  midiLast: string | null;
  /** The Desk panel (every output channel with a meter) is open on the song screen. */
  deskOpen: boolean;
  /** Channel (1-based) heard on a 2-channel device instead of the full mix; null = the mix. */
  deskListen: number | null;
  /** Open the next song in the current mode instead of Practice (Live song list). */
  keepModeOnOpen: boolean;
  toast: { text: string; kind: 'info' | 'error' } | null;
  engineError: string | null;
}

export const useApp = create<AppState>(() => ({
  route: { name: 'library' },
  projects: [],
  setlists: [],
  current: null,
  mode: 'practice',
  speed: 1,
  click: false,
  countIn: false,
  loop: false,
  selected: null,
  quantize: 'segmentEnd',
  fade: loadFade(),
  outputs: loadSetup(),
  outputChannels: null,
  snap: 'bar',
  arrangementId: null,
  transport: { playing: false, segment: 0, pending: null },
  live: null,
  liveArrangementId: null,
  liveEnded: false,
  liveMuted: [],
  liveMutedGroups: [],
  liveMuteAll: false,
  liveRepeat: false,
  cues: loadCues(),
  cueVoice: { status: 'idle' },
  midi: { status: 'off', inputs: [] },
  midiMap: loadMidiMap(),
  midiLearn: null,
  midiLast: null,
  deskOpen: false,
  deskListen: null,
  keepModeOnOpen: false,
  toast: null,
  engineError: null,
}));

export const getState = useApp.getState;
export const setState = useApp.setState;
