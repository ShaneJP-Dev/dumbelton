import type { StemParams } from '../audio/core/types';
import type { Project } from './types';

/**
 * What the engine should do with each track. Live mode is "super live":
 * the song's Practice mutes and solos are ignored, and only tracks muted on
 * the Live screen (held for 3 s) are silent.
 */
export function stemParams(p: Project, mode: 'practice' | 'arrange' | 'live', liveMuted: string[]): StemParams[] {
  const live = mode === 'live';
  return p.stems.map((s) => ({
    gain: s.gain,
    pan: s.pan,
    mute: live ? liveMuted.includes(s.id) : s.muted,
    solo: live ? false : s.solo,
  }));
}

/** How long a track must be held on the Live screen to mute it. */
export const LIVE_MUTE_HOLD_MS = 3000;
