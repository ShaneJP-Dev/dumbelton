import { AudioEngine } from '../audio/engine/AudioEngine';
import { loadWireSong } from '../audio/import/pcmStore';
import type { Grid } from '../audio/core/types';
import type { Project } from '../lib/types';
import { groupForStem } from '../lib/outputs';
import { clickAudible, stemParams, type LiveMutes } from '../lib/stemParams';
import { memoryBudgetBytes, projectBytes } from '../audio/live/budget';
import { getState, setState, type AppState } from './store';

let enginePromise: Promise<AudioEngine> | null = null;
let engineInstance: AudioEngine | null = null;

/** Create (once) and return the audio engine. Call from a user gesture where possible. */
export function getEngine(): Promise<AudioEngine> {
  if (!enginePromise) {
    enginePromise = AudioEngine.create().then(async (e) => {
      engineInstance = e;
      // use the saved output device (e.g. Dante Virtual Soundcard) and learn its channel count
      let channels = e.outputChannels;
      try {
        channels = await e.setOutputDevice(getState().outputs.deviceId);
      } catch {
        /* device gone: stay on the default output */
      }
      setState({ outputChannels: channels });
      if (import.meta.env.DEV || import.meta.env.MODE === 'test' || (window as { __e2e?: boolean }).__e2e) {
        (window as unknown as { __engine: AudioEngine }).__engine = e;
      }
      return e;
    });
    enginePromise.catch(() => (enginePromise = null));
  }
  return enginePromise;
}

export function peekEngine(): AudioEngine | null {
  return engineInstance;
}

export function projectGrid(p: Project): Grid {
  return { beats: p.beats, downbeats: p.downbeats };
}

export function liveMutes(s: Pick<AppState, 'liveMuted' | 'liveMutedGroups' | 'liveMuteAll'> = getState()): LiveMutes {
  return { tracks: s.liveMuted, groups: s.liveMutedGroups, all: s.liveMuteAll };
}

/** The Outputs group a track belongs to (Click, Guide, Drums…), by name or pinned output. */
export function stemGroupId(stem: { name: string; output?: string }): string {
  return groupForStem(getState().outputs, stem).id;
}

/** The app's click, after Live's Click-group and "mute all" mutes. */
export function applyClick(engine: AudioEngine): void {
  const s = getState();
  const clickGroup = s.outputs.groups.find((g) => g.click)?.id ?? null;
  engine.setClick({ enabled: clickAudible(s.click, s.mode, liveMutes(s), clickGroup) });
}

export function applyStemParams(engine: AudioEngine, p: Project): void {
  engine.setMasterGain(p.masterGain ?? 1);
  stemParams(p, getState().mode, liveMutes(), stemGroupId).forEach((params, i) => engine.setStem(i, params));
  applyClick(engine);
}

const loading = new Map<string, Promise<void>>();

/**
 * Make `project` the active song (slot 0 by default). If the other slot already
 * holds it (preloaded in Live), switch to that slot instead of reading it again.
 */
export async function activateProject(project: Project, keepOther = false): Promise<AudioEngine> {
  const engine = await getEngine();
  const have = engine.slots.indexOf(project.id);
  let slot: 0 | 1;
  if (have >= 0) {
    slot = have as 0 | 1;
  } else {
    // load into the slot that is not playing, so the current song keeps going until the switch
    slot = engine.activeSlot === 0 ? 1 : 0;
    if (engine.slots[slot]) engine.unload(slot);
    const activeId = engine.activeSongId;
    const active = activeId ? getState().projects.find((p) => p.id === activeId) : undefined;
    if (active && projectBytes(active) + projectBytes(project) > memoryBudgetBytes()) {
      // both would not fit: free the current song first
      engine.unload(engine.activeSlot as 0 | 1);
    }
    await preloadProject(project, slot);
  }
  if (engine.activeSlot !== slot || engine.activeSongId !== project.id) engine.activate(slot);
  applyStemParams(engine, project);
  const other = slot === 0 ? 1 : 0;
  if (!keepOther && engine.slots[other]) engine.unload(other);
  return engine;
}

/** Load a song's PCM into a slot without activating it. */
export async function preloadProject(project: Project, slot: 0 | 1): Promise<void> {
  const engine = await getEngine();
  if (engine.slots[slot] === project.id) return;
  const key = `${slot}:${project.id}`;
  let p = loading.get(key);
  if (!p) {
    p = (async () => {
      const wire = await loadWireSong(project);
      await engine.load(slot, wire, projectGrid(project));
    })();
    loading.set(key, p);
    p.finally(() => loading.delete(key));
  }
  await p;
}
