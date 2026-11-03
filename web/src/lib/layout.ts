import { playableItems } from './arrangement';
import type { Arrangement, Project, Section } from './types';

/** A stretch of the source song placed on the timeline. */
export interface Clip {
  key: string;
  section: Section | null;
  /** Source frames [start, end). */
  start: number;
  end: number;
  /** Where the clip starts on the displayed timeline (frames). */
  offset: number;
}

export interface Layout {
  clips: Clip[];
  /** Displayed length in frames. */
  length: number;
  /** true when showing an arrangement (clips in a new order), false for the song as recorded. */
  arranged: boolean;
}

export function songLayout(p: Project): Layout {
  return { clips: [{ key: 'song', section: null, start: 0, end: p.lengthFrames, offset: 0 }], length: p.lengthFrames, arranged: false };
}

/** The arrangement laid end to end, in its order, one clip per item (matches the engine's program). */
export function arrangementLayout(p: Project, arr: Arrangement): Layout {
  const byId = new Map(p.sections.map((s) => [s.id, s]));
  let offset = 0;
  const clips: Clip[] = playableItems(p, arr).map((it) => {
    const s = byId.get(it.sectionId)!;
    const c = { key: it.id, section: s, start: s.start, end: s.end, offset };
    offset += s.end - s.start;
    return c;
  });
  return { clips, length: offset, arranged: true };
}

/** Displayed position of source frame f while the engine plays clip `index` (song layout: f itself). */
export function displayFrame(layout: Layout, f: number, index: number): number {
  if (!layout.arranged) return f;
  const c = layout.clips[index];
  if (!c) return 0;
  return c.offset + Math.max(0, Math.min(c.end - c.start, f - c.start));
}

/** Which clip and source frame a displayed position points at. */
export function sourceAt(layout: Layout, d: number): { index: number; frame: number } | null {
  if (layout.clips.length === 0) return null;
  let i = layout.clips.findIndex((c) => d < c.offset + (c.end - c.start));
  if (i < 0) i = layout.clips.length - 1;
  const c = layout.clips[i];
  const frame = Math.max(c.start, Math.min(c.end - 1, Math.round(c.start + (d - c.offset))));
  return { index: i, frame };
}
