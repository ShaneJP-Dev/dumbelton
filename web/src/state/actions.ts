import { db } from '../lib/db';
import { arrangementProgram, liveProgram, songProgram } from '../lib/arrangement';
import { deleteProjectData } from '../lib/importer';
import type { SongKey } from '../lib/musicKey';
import type { Project, Section, Setlist } from '../lib/types';
import { addSectionAt, snapFrame } from '../lib/sections';
import { fadeFrames, saveFade, type FadeBeats } from '../lib/fade';
import { buildRouting, saveSetup, type OutputSetup } from '../lib/outputs';
import { barLength } from '../audio/core/grid';
import { SAMPLE_RATE } from '../audio/core/types';
import type { Program } from '../audio/core/types';
import { loadVoice, type CueLang } from '../lib/voice';
import { activateProject, applyClick, applyCues, applyStemParams, getEngine, peekEngine, projectGrid } from './engine';
import { getState, setState, type Mode, type Route } from './store';

// ------------------------------------------------------------------ routing

export function routeFromHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  if (a === 'song' && b) return { name: 'song', id: decodeURIComponent(b) };
  if (a === 'setlists') return { name: 'setlists' };
  if (a === 'setlist' && b) return { name: 'setlist', id: decodeURIComponent(b) };
  if (a === 'outputs') return { name: 'outputs' };
  if (a === 'controls') return { name: 'controls' };
  return { name: 'library' };
}

export function hashFor(r: Route): string {
  switch (r.name) {
    case 'song':
      return `#/song/${encodeURIComponent(r.id)}`;
    case 'setlists':
      return '#/setlists';
    case 'setlist':
      return `#/setlist/${encodeURIComponent(r.id)}`;
    case 'outputs':
      return '#/outputs';
    case 'controls':
      return '#/controls';
    default:
      return '#/';
  }
}

export function navigate(r: Route): void {
  const h = hashFor(r);
  if (window.location.hash !== h) window.location.hash = h;
  else setState({ route: r });
}

// ------------------------------------------------------------------ toasts

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  setState({ toast: { text, kind } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: null }), kind === 'error' ? 6000 : 3000);
}

// ------------------------------------------------------------------ library

export async function refreshLibrary(): Promise<void> {
  const [projects, setlists] = await Promise.all([
    db.projects.orderBy('updatedAt').reverse().toArray(),
    db.setlists.orderBy('updatedAt').reverse().toArray(),
  ]);
  setState({ projects, setlists });
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(p: Project): void {
  clearTimeout(saveTimers.get(p.id));
  saveTimers.set(
    p.id,
    setTimeout(() => {
      saveTimers.delete(p.id);
      void db.projects.put(p);
    }, 250),
  );
}

export async function flushSaves(): Promise<void> {
  const cur = getState().current;
  for (const [id, t] of saveTimers) {
    clearTimeout(t);
    saveTimers.delete(id);
    const p = id === cur?.id ? cur : getState().projects.find((x) => x.id === id);
    if (p) await db.projects.put(p);
  }
}

/** Update the open project (and the library list); persisted shortly after. */
export function patchProject(fn: (p: Project) => Project): Project | null {
  const cur = getState().current;
  if (!cur) return null;
  const next = { ...fn(cur), updatedAt: Date.now() };
  setState((s) => ({
    current: next,
    projects: s.projects.map((p) => (p.id === next.id ? next : p)),
  }));
  scheduleSave(next);
  return next;
}

/** Update any project by id (used by background analysis). */
export async function patchProjectById(id: string, fn: (p: Project) => Project): Promise<Project | null> {
  const cur = getState().current;
  if (cur?.id === id) return patchProject(fn);
  const p = (await db.projects.get(id)) ?? null;
  if (!p) return null;
  const next = { ...fn(p), updatedAt: Date.now() };
  await db.projects.put(next);
  setState((s) => ({ projects: s.projects.map((x) => (x.id === id ? next : x)) }));
  return next;
}

export async function deleteProject(id: string): Promise<void> {
  const engine = peekEngine();
  if (engine) engine.slots.forEach((sid, slot) => sid === id && engine.unload(slot as 0 | 1));
  await deleteProjectData(id);
  // remove from setlists
  const setlists = await db.setlists.toArray();
  for (const sl of setlists) {
    if (sl.entries.some((e) => e.projectId === id)) {
      await db.setlists.put({ ...sl, entries: sl.entries.filter((e) => e.projectId !== id), updatedAt: Date.now() });
    }
  }
  if (getState().current?.id === id) setState({ current: null });
  await refreshLibrary();
}

// ------------------------------------------------------------------ song / engine

let unsubEngine: (() => void) | null = null;

function watchEngine(): void {
  const engine = peekEngine();
  if (!engine || unsubEngine) return;
  const offPos = engine.onPosition(() => {
    const r = engine.clock.report;
    if (!r) return;
    const t = getState().transport;
    const pend = r.pending;
    if (
      t.playing !== r.playing ||
      t.segment !== r.segment ||
      (t.pending?.at ?? -1) !== (pend?.at ?? -1) ||
      (t.pending?.to ?? -1) !== (pend?.to ?? -1)
    ) {
      setState({ transport: { playing: r.playing, segment: r.segment, pending: pend } });
    }
  });
  const offEv = engine.on((e) => {
    if (e.type === 'ended') onSongEnded();
    if (e.type === 'repeat') setState({ liveRepeat: e.on }); // a queued jump landed and ended the vamp
  });
  unsubEngine = () => {
    offPos();
    offEv();
  };
}

let endedHandler: (() => void) | null = null;
export function setEndedHandler(fn: (() => void) | null): void {
  endedHandler = fn;
}
function onSongEnded(): void {
  endedHandler?.();
}

export async function openProject(id: string, opts: { keepMode?: boolean } = {}): Promise<Project | null> {
  await flushSaves();
  const p = getState().projects.find((x) => x.id === id) ?? (await db.projects.get(id)) ?? null;
  if (!p) return null;
  const prev = getState().current;
  const keepFlag = getState().keepModeOnOpen;
  if (prev?.id !== id) {
    setState({
      current: p,
      selected: null,
      loop: false,
      liveEnded: false,
      liveMuted: [],
      liveRepeat: false,
      arrangementId: p.arrangements[0]?.id ?? null,
      transport: { playing: false, segment: 0, pending: null },
      // a different song opens in Practice, unless a setlist / resumed live session is running
      ...(opts.keepMode || getState().live || keepFlag ? {} : { mode: 'practice' as const }),
    });
  }
  if (keepFlag) setState({ keepModeOnOpen: false });
  try {
    const engine = await activateProject(p, getState().live !== null);
    setState({ engineError: null });
    watchEngine();
    applyClick(engine);
    engine.setRepeat(getState().mode === 'live' && getState().liveRepeat);
    engine.setSpeed(getState().speed);
    engine.setTranspose(p.transpose ?? 0);
    syncTransition();
    syncRouting();
    syncProgram();
    void ensureCueVoice();
  } catch (err) {
    setState({ engineError: String((err as Error).message ?? err) });
  }
  return p;
}

/** The program the engine should play for the current mode and selections. */
export function currentProgram(): Program | null {
  const { current, mode, loop, selected, arrangementId } = getState();
  if (!current) return null;
  if (mode === 'arrange') {
    const arr = current.arrangements.find((a) => a.id === arrangementId);
    if (arr && arr.items.length) return arrangementProgram(current, arr);
    return songProgram(current, null);
  }
  if (mode === 'live') return liveProgram(current, getState().liveArrangementId);
  return songProgram(current, loop ? selected : null);
}

export function syncProgram(): void {
  const engine = peekEngine();
  const p = currentProgram();
  const cur = getState().current;
  if (!engine || !p || !cur || engine.activeSongId !== cur.id) return;
  engine.setProgram(p);
  applyCues(engine, cur); // pads (and their words) follow the program
}

export function setMode(mode: Mode): void {
  const entering = mode === 'live' && getState().mode !== 'live';
  // entering Live: nothing muted ("super live"); leaving: the song's own mutes come back
  setState(entering ? { mode, liveMuted: [], liveMutedGroups: [], liveMuteAll: false, liveRepeat: false } : { mode, liveRepeat: false });
  peekEngine()?.setRepeat(false);
  syncStems();
  syncProgram();
  if (mode === 'live') void ensureCueVoice();
}

let cueToastShown = false;

/**
 * Load the spoken cue words for the current song's language (Spanish if its
 * guide speaks Spanish, else English) when Live needs them.
 */
export async function ensureCueVoice(): Promise<void> {
  const { current, mode, cues, cueVoice } = getState();
  if (!current || mode !== 'live' || !cues) return;
  const want: CueLang = current.analysis.guideLanguage === 'es' ? 'es' : 'en';
  if ((cueVoice.status === 'ready' || cueVoice.status === 'loading') && cueVoice.lang === want) return;
  setState({ cueVoice: { status: 'loading', lang: want } });
  try {
    let bank;
    try {
      bank = await loadVoice(want);
    } catch (err) {
      if (want === 'en') throw err;
      bank = await loadVoice('en'); // no Spanish voice on this computer: English words
    }
    const engine = await getEngine();
    engine.setCueClips(bank.clips);
    setState({ cueVoice: { status: 'ready', lang: bank.lang, voice: bank.voice } });
    // a song in the other language may have opened meanwhile
    if (getState().current?.analysis.guideLanguage !== current.analysis.guideLanguage) void ensureCueVoice();
  } catch (err) {
    const message = String((err as Error).message ?? err);
    setState({ cueVoice: { status: 'unavailable', lang: want, message } });
    if (!cueToastShown) {
      cueToastShown = true;
      toast(`Spoken cues are off: ${message}.`, 'info');
    }
  }
  syncStems();
}

/** Turn spoken cues on or off (saved in this browser). */
export function setCuesEnabled(on: boolean): void {
  setState({ cues: on });
  try {
    localStorage.setItem('musical.cues', on ? 'on' : 'off');
  } catch {
    /* storage unavailable */
  }
  if (on && getState().cueVoice.status === 'unavailable') setState({ cueVoice: { status: 'idle' } }); // try again
  syncStems();
  void ensureCueVoice();
}

/** Live "Repeat" (vamp): loop the current section until another one is tapped. */
export function setLiveRepeat(on: boolean): void {
  setState({ liveRepeat: on });
  peekEngine()?.setRepeat(on && getState().mode === 'live');
}

function toggled(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** Mute or unmute a track on the Live screen (does not change the song's saved mutes). */
export function toggleLiveTrack(stemId: string): void {
  setState({ liveMuted: toggled(getState().liveMuted, stemId) });
  syncStems();
}

/** Mute or unmute an output group (Click, Guide, Drums…) on the Live screen. */
export function toggleLiveGroup(groupId: string): void {
  setState({ liveMutedGroups: toggled(getState().liveMutedGroups, groupId) });
  syncStems();
}

/** Clear every Live mute: tracks, groups and Mute all. */
export function unmuteEverything(): void {
  setState({ liveMuted: [], liveMutedGroups: [], liveMuteAll: false });
  syncStems();
}

/** "Mute all" on the Live screen. Unmuting brings back exactly what was muted before. */
export function setLiveMuteAll(on: boolean): void {
  setState({ liveMuteAll: on });
  syncStems();
}

/** Push the project's grid to the engine after analysis or edits. */
export function syncGrid(): void {
  const engine = peekEngine();
  const cur = getState().current;
  if (engine && cur && engine.activeSongId === cur.id) engine.setGrid(projectGrid(cur));
  syncTransition(); // fades are measured in beats, which may have changed
}

/** Send the fade length (in this song's beats) to the engine. */
export function syncTransition(): void {
  const engine = peekEngine();
  const { current, fade } = getState();
  if (engine && current && engine.activeSongId === current.id) engine.setTransition(fadeFrames(current, fade));
}

/** Send the output routing for the open song's tracks to the engine. */
export function syncRouting(): void {
  const engine = peekEngine();
  const { current, outputs } = getState();
  if (engine && current && engine.activeSongId === current.id) engine.setRouting(buildRouting(outputs, current.stems));
}

/** Change (and save) the output setup; switches the device if it changed. */
export async function setOutputs(next: OutputSetup): Promise<void> {
  const prev = getState().outputs;
  setState({ outputs: next });
  saveSetup(next);
  syncRouting();
  syncStems(); // Live group mutes follow tracks into their (new) groups
  if (next.deviceId !== prev.deviceId) {
    const engine = peekEngine();
    if (engine) {
      try {
        setState({ outputChannels: await engine.setOutputDevice(next.deviceId) });
      } catch (err) {
        toast(`Could not use that output: ${(err as Error).message}`, 'error');
      }
    }
  }
}

export function setFade(fade: FadeBeats): void {
  setState({ fade });
  saveFade(fade);
  syncTransition();
}

export function syncStems(): void {
  const engine = peekEngine();
  const cur = getState().current;
  if (engine && cur && engine.activeSongId === cur.id) applyStemParams(engine, cur);
}

export async function togglePlay(): Promise<void> {
  const engine = await getEngine();
  const { transport, countIn } = getState();
  if (transport.playing) engine.pause();
  else engine.play({ countIn });
}

export function setSpeed(speed: number): void {
  setState({ speed });
  peekEngine()?.setSpeed(speed);
}

/** Set (or clear) the current song's original key by hand. */
export function setOriginalKey(key: SongKey | undefined): void {
  patchProject((p) => ({ ...p, key }));
}

/** Change the current song's key by semitones (-6..+6), saved with the song. */
export function setTranspose(semitones: number): void {
  const t = Math.max(-6, Math.min(6, Math.round(semitones)));
  patchProject((p) => ({ ...p, transpose: t }));
  peekEngine()?.setTranspose(t);
}

export function setClick(on: boolean): void {
  setState({ click: on });
  const engine = peekEngine();
  if (engine) applyClick(engine);
}

// ------------------------------------------------------------------ sections

/** Shortest section allowed when editing: one bar (at least half a second). */
export function minSectionLength(p: Project): number {
  return Math.max(SAMPLE_RATE / 2, p.downbeats.length >= 2 ? barLength(p.downbeats) : SAMPLE_RATE);
}

/**
 * Add a section starting at `frame` (snapped to bar/beat per the snap setting)
 * and select it. Returns the new section, or null (with a message) if it would
 * be too short.
 */
export function addSectionAtFrame(frame: number): Section | null {
  const { current, snap } = getState();
  if (!current) return null;
  if (current.sections.length === 0) {
    toast('Find or mark the song’s sections first.');
    return null;
  }
  const f = snapFrame(frame, snap, current.beats, current.downbeats);
  const r = addSectionAt(current.sections, f, minSectionLength(current));
  if ('error' in r) {
    toast(r.error);
    return null;
  }
  patchProject((p) => ({ ...p, sections: r.sections }));
  setState({ selected: r.added.id });
  syncProgram();
  return r.added;
}

// ------------------------------------------------------------------ setlists

export async function saveSetlist(sl: Setlist): Promise<void> {
  const next = { ...sl, updatedAt: Date.now() };
  await db.setlists.put(next);
  setState((s) => ({
    setlists: s.setlists.some((x) => x.id === next.id)
      ? s.setlists.map((x) => (x.id === next.id ? next : x))
      : [next, ...s.setlists],
  }));
}

export async function deleteSetlist(id: string): Promise<void> {
  await db.setlists.delete(id);
  setState((s) => ({ setlists: s.setlists.filter((x) => x.id !== id) }));
}
