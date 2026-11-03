import { canPreload } from '../audio/live/budget';
import { db } from '../lib/db';
import type { Project } from '../lib/types';
import { navigate, setEndedHandler, toast } from './actions';
import { getEngine, preloadProject } from './engine';
import { getState, setState } from './store';

const LIVE_KEY = 'musical.live';

interface SavedLive {
  setlistId: string | null;
  index: number;
  projectId: string;
  arrangementId: string | null;
  segment: number;
}

export function saveLiveState(segment: number): void {
  const { live, current, mode, liveArrangementId } = getState();
  if (mode !== 'live' || !current) return;
  const s: SavedLive = {
    setlistId: live?.setlistId ?? null,
    index: live?.index ?? 0,
    projectId: current.id,
    arrangementId: liveArrangementId,
    segment,
  };
  try {
    localStorage.setItem(LIVE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export function clearLiveState(): void {
  try {
    localStorage.removeItem(LIVE_KEY);
  } catch {
    /* ignore */
  }
}

/** After a reload: put the song back in Live mode at the section it was on. */
export function restoreLiveState(projectId: string): number | null {
  try {
    const raw = localStorage.getItem(LIVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedLive;
    if (s.projectId !== projectId) return null;
    setState({
      mode: 'live',
      live: s.setlistId ? { setlistId: s.setlistId, index: s.index } : null,
      liveArrangementId: s.arrangementId,
    });
    return s.segment;
  } catch {
    return null;
  }
}

async function projectById(id: string): Promise<Project | undefined> {
  return getState().projects.find((p) => p.id === id) ?? (await db.projects.get(id));
}

/** Start (or move within) a setlist in Live mode. */
export async function goToSetlistIndex(setlistId: string, index: number): Promise<void> {
  const sl = getState().setlists.find((s) => s.id === setlistId) ?? (await db.setlists.get(setlistId));
  if (!sl || index < 0 || index >= sl.entries.length) return;
  const entry = sl.entries[index];
  if (!(await projectById(entry.projectId))) {
    toast('That song is no longer on this device.', 'error');
    return;
  }
  (await getEngine()).pause();
  setState({
    live: { setlistId, index },
    liveArrangementId: entry.arrangementId ?? null,
    liveEnded: false,
    mode: 'live',
  });
  navigate({ name: 'song', id: entry.projectId });
}

/** Open any song in Live mode (from the Live song list's "All songs" view). */
export async function goToSongLive(projectId: string): Promise<void> {
  if (getState().current?.id === projectId && !getState().live) return;
  (await getEngine()).pause();
  setState({ live: null, liveArrangementId: null, liveEnded: false, mode: 'live', keepModeOnOpen: true });
  navigate({ name: 'song', id: projectId });
}

export function nextSong(delta = 1): void {
  const { live } = getState();
  if (live) void goToSetlistIndex(live.setlistId, live.index + delta);
}

export function exitLive(): void {
  setState({ live: null, liveArrangementId: null, liveEnded: false, mode: 'practice' });
  clearLiveState();
}

/** Preload the next setlist song into the free engine slot, if memory allows. */
export async function preloadNextSong(): Promise<void> {
  const { live, current } = getState();
  if (!live || !current) return;
  const sl = getState().setlists.find((s) => s.id === live.setlistId);
  const entry = sl?.entries[live.index + 1];
  if (!entry) return;
  const next = await projectById(entry.projectId);
  if (!next || next.id === current.id) return;
  if (!canPreload(current, next)) return; // loads when the song starts instead (~1-2 s)
  const engine = await getEngine();
  const free = engine.activeSlot === 0 ? 1 : 0;
  try {
    await preloadProject(next, free);
  } catch {
    /* not fatal: it loads on switch */
  }
}

setEndedHandler(() => {
  if (getState().mode === 'live') setState({ liveEnded: true });
});
