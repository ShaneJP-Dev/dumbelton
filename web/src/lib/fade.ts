import { SAMPLE_RATE, XFADE_FRAMES } from '../audio/core/types';
import type { Project } from './types';

/** Fade length for jumps between parts, in beats (0 = a clean cut). 4 beats = 1 bar in 4/4. */
export type FadeBeats = 0 | 1 | 2 | 4;
export const FADE_OPTIONS: FadeBeats[] = [0, 1, 2, 4];
export const DEFAULT_FADE: FadeBeats = 1;

/** Typical beat length of the song (frames); half a second when there is no beat grid. */
export function beatFrames(p: Project): number {
  const b = p.beats;
  if (b.length < 2) return SAMPLE_RATE / 2;
  const d = b
    .slice(1)
    .map((v, i) => v - b[i])
    .sort((x, y) => x - y);
  return d[d.length >> 1];
}

export function fadeFrames(p: Project, beats: FadeBeats): number {
  return beats === 0 ? XFADE_FRAMES : Math.round(beats * beatFrames(p));
}

export function fadeLabel(beats: FadeBeats, hasGrid: boolean): string {
  if (beats === 0) return 'Cut';
  if (!hasGrid) return `${beats / 2} s`;
  if (beats === 4) return '1 bar';
  return beats === 1 ? '1 beat' : `${beats} beats`;
}

const KEY = 'musical.fade';

export function loadFade(): FadeBeats {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (localStorage.getItem(KEY) !== null && (FADE_OPTIONS as number[]).includes(v)) return v as FadeBeats;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_FADE;
}

export function saveFade(beats: FadeBeats): void {
  try {
    localStorage.setItem(KEY, String(beats));
  } catch {
    /* storage unavailable */
  }
}
