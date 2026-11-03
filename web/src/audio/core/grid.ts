import type { Frame, Program, Segment } from './types';

/** Index of the first element >= x in a sorted array (arr.length if none). */
export function lowerBound(arr: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First downbeat strictly after `f` (or null). */
export function nextDownbeat(downbeats: Frame[], f: Frame): Frame | null {
  const i = lowerBound(downbeats, f + 1);
  return i < downbeats.length ? downbeats[i] : null;
}

/** Nearest grid point to f (or f itself when the grid is empty). */
export function snap(grid: Frame[], f: Frame): Frame {
  if (grid.length === 0) return f;
  const i = lowerBound(grid, f);
  if (i === 0) return grid[0];
  if (i === grid.length) return grid[grid.length - 1];
  return f - grid[i - 1] <= grid[i] - f ? grid[i - 1] : grid[i];
}

/** Median bar length in frames (fallback: 2 s at 48 kHz). */
export function barLength(downbeats: Frame[], fallback = 96000): Frame {
  if (downbeats.length < 2) return fallback;
  const d = downbeats.slice(1).map((v, i) => v - downbeats[i]).sort((a, b) => a - b);
  return d[d.length >> 1];
}

export function linearProgram(length: Frame): Program {
  return { segments: [{ id: 'all', start: 0, end: length }], loop: false };
}

export function sectionsProgram(sections: { id: string; start: Frame; end: Frame }[], loop = false): Program {
  return { segments: sections.map((s) => ({ id: s.id, start: s.start, end: s.end })), loop };
}

/** Find the segment index that contains frame f (first match), else the nearest following one. */
export function segmentAt(segments: Segment[], f: Frame): number {
  for (let i = 0; i < segments.length; i++) {
    if (f >= segments[i].start && f < segments[i].end) return i;
  }
  for (let i = 0; i < segments.length; i++) if (segments[i].start >= f) return i;
  return Math.max(0, segments.length - 1);
}
