import { AudioEngine } from '../audio/engine/AudioEngine';
import { loadWireSong } from '../audio/import/pcmStore';
import type { Grid } from '../audio/core/types';
import type { Project } from '../lib/types';

let enginePromise: Promise<AudioEngine> | null = null;
let engineInstance: AudioEngine | null = null;

/** Create (once) and return the audio engine. Call from a user gesture where possible. */
export function getEngine(): Promise<AudioEngine> {
  if (!enginePromise) {
    enginePromise = AudioEngine.create().then((e) => {
      engineInstance = e;
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

export function applyStemParams(engine: AudioEngine, p: Project): void {
  p.stems.forEach((s, i) =>
    engine.setStem(i, { gain: s.gain, pan: s.pan, mute: s.muted, solo: s.solo, bus: s.bus }),
  );
}

const loading = new Map<string, Promise<void>>();

/**
 * Make `project` the active song (slot 0 by default). If the other slot already
 * holds it (preloaded in Live), switch to that slot instead of reading it again.
 */
export async function activateProject(project: Project, preferSlot: 0 | 1 = 0): Promise<AudioEngine> {
  const engine = await getEngine();
  const have = engine.slots.indexOf(project.id);
  if (have >= 0) {
    if (engine.activeSlot !== have) engine.activate(have as 0 | 1);
  } else {
    await preloadProject(project, preferSlot);
    engine.activate(preferSlot);
  }
  applyStemParams(engine, project);
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
