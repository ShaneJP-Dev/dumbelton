import { lowerBound, snap } from '../audio/core/grid';
import type { Frame } from '../audio/core/types';
import { uid } from './ids';
import type { Section, SectionKind } from './types';

export const KINDS: SectionKind[] = ['intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'solo', 'inst', 'break', 'outro'];

export const KIND_META: Record<SectionKind, { label: string; color: string }> = {
  intro: { label: 'Intro', color: '#64748b' },
  verse: { label: 'Verse', color: '#3b82f6' },
  'pre-chorus': { label: 'Pre-Chorus', color: '#06b6d4' },
  chorus: { label: 'Chorus', color: '#f97316' },
  bridge: { label: 'Bridge', color: '#a855f7' },
  solo: { label: 'Solo', color: '#eab308' },
  inst: { label: 'Instrumental', color: '#22c55e' },
  break: { label: 'Break', color: '#94a3b8' },
  outro: { label: 'Outro', color: '#475569' },
};

export type SnapMode = 'bar' | 'beat' | 'off';

export interface SectionWithCustom extends Section {
  custom?: boolean;
}

function asKind(label: string): SectionKind {
  const l = label.toLowerCase();
  return (KINDS as string[]).includes(l) ? (l as SectionKind) : 'inst';
}

/** Recompute automatic names ("Verse 1", "Verse 2"); sections the user renamed keep their name. */
export function renumber<T extends SectionWithCustom>(sections: T[]): T[] {
  const totals = new Map<SectionKind, number>();
  for (const s of sections) totals.set(s.kind, (totals.get(s.kind) ?? 0) + 1);
  const seen = new Map<SectionKind, number>();
  return sections.map((s) => {
    const k = (seen.get(s.kind) ?? 0) + 1;
    seen.set(s.kind, k);
    if (s.custom) return s;
    const base = KIND_META[s.kind].label;
    return { ...s, name: (totals.get(s.kind) ?? 0) > 1 ? `${base} ${k}` : base };
  });
}

export interface AnalysisSection {
  start: number;
  end: number;
  label: string;
  name?: string;
}

const toFrame = (sec: number, sr: number) => Math.round(sec * sr);

/** Convert the analyzer's seconds to frames; keep sections contiguous over [0, length]. */
export function sectionsFromAnalysis(raw: AnalysisSection[], lengthFrames: Frame, sr: number): Section[] {
  const out: SectionWithCustom[] = raw
    .map((r) => ({ id: uid('x_'), kind: asKind(r.label), name: '', start: toFrame(r.start, sr), end: toFrame(r.end, sr) }))
    .filter((s) => s.end > s.start);
  if (out.length === 0) return defaultSections(lengthFrames);
  out[0].start = 0;
  for (let i = 1; i < out.length; i++) out[i].start = out[i - 1].end;
  out[out.length - 1].end = lengthFrames;
  return renumber(out);
}

export function defaultSections(lengthFrames: Frame): Section[] {
  return [{ id: uid('x_'), kind: 'verse', name: 'Song', start: 0, end: lengthFrames, custom: true } as SectionWithCustom];
}

export function sectionIndexAt(sections: Section[], f: Frame): number {
  if (sections.length === 0) return -1;
  let lo = 0;
  let hi = sections.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (sections[mid].start <= f) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function snapFrame(f: Frame, mode: SnapMode, beats: Frame[], downbeats: Frame[]): Frame {
  if (mode === 'bar' && downbeats.length) return snap(downbeats, f);
  if (mode === 'beat' && beats.length) return snap(beats, f);
  return Math.round(f);
}

/** Move the boundary between sections[i-1] and sections[i] (both resize). */
export function moveBoundary(sections: Section[], i: number, f: Frame, minLen: Frame): Section[] {
  if (i <= 0 || i >= sections.length) return sections;
  const lo = sections[i - 1].start + minLen;
  const hi = sections[i].end - minLen;
  if (lo > hi) return sections;
  const x = Math.max(lo, Math.min(hi, Math.round(f)));
  const out = sections.slice();
  out[i - 1] = { ...out[i - 1], end: x };
  out[i] = { ...out[i], start: x };
  return out;
}

/** Split the section containing f at f. The new right part gets the same kind. */
export function splitAt(sections: Section[], f: Frame, minLen: Frame): Section[] {
  const i = sectionIndexAt(sections, f);
  if (i < 0) return sections;
  const s = sections[i];
  if (f - s.start < minLen || s.end - f < minLen) return sections;
  const left: SectionWithCustom = { ...s, end: f };
  const right: SectionWithCustom = { ...s, id: uid('x_'), start: f, custom: false };
  return renumber([...sections.slice(0, i), left, right, ...sections.slice(i + 1)]);
}

export function mergeWithNext(sections: Section[], i: number): Section[] {
  if (i < 0 || i >= sections.length - 1) return sections;
  const merged = { ...sections[i], end: sections[i + 1].end };
  return renumber([...sections.slice(0, i), merged, ...sections.slice(i + 2)]);
}

/** Remove a section; its time goes to the previous section (or the next, for the first). */
export function removeSection(sections: Section[], i: number): Section[] {
  if (sections.length <= 1 || i < 0 || i >= sections.length) return sections;
  if (i === 0) {
    const next = { ...sections[1], start: sections[0].start };
    return renumber([next, ...sections.slice(2)]);
  }
  const prev = { ...sections[i - 1], end: sections[i].end };
  return renumber([...sections.slice(0, i - 1), prev, ...sections.slice(i + 1)]);
}

export function setKind(sections: Section[], i: number, kind: SectionKind): Section[] {
  const out = sections.map((s, j) => (j === i ? ({ ...s, kind, custom: false } as SectionWithCustom) : s));
  return renumber(out);
}

export function renameSection(sections: Section[], i: number, name: string): Section[] {
  const trimmed = name.trim();
  const out = sections.map((s, j) =>
    j === i ? ({ ...s, name: trimmed || s.name, custom: trimmed.length > 0 } as SectionWithCustom) : s,
  );
  return renumber(out);
}

/** Bars spanned by a section (using the downbeat grid). */
export function barsIn(s: Section, downbeats: Frame[]): number {
  if (downbeats.length === 0) return 0;
  return lowerBound(downbeats, s.end) - lowerBound(downbeats, s.start);
}

/** "Verse 1" -> "V1", "Pre-Chorus" -> "PC", "Instrumental 2" -> "In2" for narrow blocks. */
export function shortName(name: string): string {
  const m = name.match(/^(.*?)(?:\s+(\d+))?$/);
  const base = (m?.[1] ?? name).trim();
  const num = m?.[2] ?? '';
  const parts = base.split(/[\s-]+/).filter(Boolean);
  const abbr = parts.length > 1 ? parts.map((p) => p[0].toUpperCase()).join('') : base.startsWith('Instr') ? 'In' : base.slice(0, 1).toUpperCase();
  return abbr + num;
}
