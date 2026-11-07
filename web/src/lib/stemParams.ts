import type { StemParams } from '../audio/core/types';
import type { Project, Stem } from './types';

/** What is muted on the Live screen. */
export interface LiveMutes {
  /** Single tracks (ids). */
  tracks: string[];
  /** Output groups (ids from the Outputs screen: click, guide, drums…). */
  groups: string[];
  /** Mute all: everything silent, the song keeps playing. */
  all: boolean;
}

export const NO_LIVE_MUTES: LiveMutes = { tracks: [], groups: [], all: false };

/** Why a track is silent on the Live screen, or null if it plays. */
export function liveMuteReason(stem: Stem, live: LiveMutes, groupOf: (s: Stem) => string): 'all' | 'group' | 'track' | null {
  if (live.tracks.includes(stem.id)) return 'track';
  if (live.groups.includes(groupOf(stem))) return 'group';
  if (live.all) return 'all';
  return null;
}

/**
 * What the engine should do with each track. Live mode is "super live":
 * the song's Practice mutes and solos are ignored; only tracks, groups or
 * "mute all" muted on the Live screen are silent.
 */
export function stemParams(
  p: Project,
  mode: 'practice' | 'arrange' | 'live',
  live: LiveMutes,
  groupOf: (s: Stem) => string,
): StemParams[] {
  const isLive = mode === 'live';
  return p.stems.map((s) => ({
    gain: s.gain,
    pan: s.pan,
    mute: isLive ? liveMuteReason(s, live, groupOf) !== null : s.muted,
    solo: isLive ? false : s.solo,
  }));
}

/**
 * Whether the app's own click should sound. In Live, "mute all" and muting
 * the group the click is routed to (Click) silence it too.
 */
export function clickAudible(clickOn: boolean, mode: 'practice' | 'arrange' | 'live', live: LiveMutes, clickGroupId: string | null): boolean {
  if (!clickOn) return false;
  if (mode !== 'live') return true;
  if (live.all) return false;
  return !(clickGroupId && live.groups.includes(clickGroupId));
}

/** How long "Mute all" must be held on the Live screen. */
export const LIVE_MUTE_ALL_HOLD_MS = 2000;
