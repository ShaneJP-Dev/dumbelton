import { linearProgram, sectionsProgram } from '../audio/core/grid';
import type { Program } from '../audio/core/types';
import { uid } from './ids';
import type { Arrangement, Project } from './types';

/** Segments for an arrangement (items whose section was deleted are skipped). */
export function arrangementProgram(project: Project, arr: Arrangement): Program {
  const byId = new Map(project.sections.map((s) => [s.id, s]));
  const segments = arr.items
    .map((it) => {
      const s = byId.get(it.sectionId);
      return s ? { id: it.id, start: s.start, end: s.end } : null;
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
  return { segments, loop: false };
}

/** Items that still point at an existing section (the ones that play). */
export function playableItems(project: Project, arr: Arrangement) {
  const ids = new Set(project.sections.map((s) => s.id));
  return arr.items.filter((it) => ids.has(it.sectionId));
}

export function arrangementLength(project: Project, arr: Arrangement): number {
  return arrangementProgram(project, arr).segments.reduce((n, s) => n + (s.end - s.start), 0);
}

export function newArrangement(project: Project, name?: string): Arrangement {
  return {
    id: uid('a_'),
    name: name ?? `Arrangement ${project.arrangements.length + 1}`,
    items: project.sections.map((s) => ({ id: uid('i_'), sectionId: s.id })),
  };
}

export function songProgram(project: Project, loopSectionId: string | null): Program {
  if (loopSectionId) {
    const s = project.sections.find((x) => x.id === loopSectionId);
    if (s) return { segments: [{ id: s.id, start: s.start, end: s.end }], loop: true };
  }
  return linearProgram(project.lengthFrames);
}

/** Live mode plays an arrangement (from a setlist entry) or the song's sections in order. */
export function liveProgram(project: Project, arrangementId: string | null = null): Program {
  const arr = arrangementId ? project.arrangements.find((a) => a.id === arrangementId) : undefined;
  if (arr && playableItems(project, arr).length) return arrangementProgram(project, arr);
  if (project.sections.length === 0) return linearProgram(project.lengthFrames);
  return sectionsProgram(project.sections);
}

/** One pad per segment of the live program. */
export function livePads(project: Project, arrangementId: string | null = null) {
  const arr = arrangementId ? project.arrangements.find((a) => a.id === arrangementId) : undefined;
  const byId = new Map(project.sections.map((s) => [s.id, s]));
  if (arr) {
    const items = playableItems(project, arr);
    if (items.length) return items.map((it) => ({ key: it.id, section: byId.get(it.sectionId)! }));
  }
  return project.sections.map((s) => ({ key: s.id, section: s }));
}
