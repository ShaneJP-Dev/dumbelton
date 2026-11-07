import { groupForStem, type OutputSetup } from './outputs';
import type { Stem } from './types';

/** What the analyzer heard on the guide track. */
export interface GuideResult {
  status: 'ok' | 'few-cues' | 'unavailable' | 'error' | 'off';
  language?: 'en' | 'es';
  cues: { time: number; end: number; kind: string; word: string; conf: number }[];
  message?: string;
}

const LANGUAGE: Record<string, string> = { en: 'English', es: 'Spanish' };

/**
 * Tracks that speak the section cues: the Outputs screen's Guide group (same
 * keywords: guide, cue, cues), or else any track named like one ("Click + Guide").
 */
export function guideStems(stems: Stem[], outputs: OutputSetup): Stem[] {
  const inGroup = stems.filter((s) => groupForStem(outputs, s).id === 'guide');
  return inGroup.length ? inGroup : stems.filter((s) => /guide|\bcues?\b/i.test(s.name));
}

/** A short note for the user about the guide track after analysis, or null when there is nothing to say. */
export function guideMessage(guide: GuideResult | undefined, sectionsFrom: string | undefined): { text: string; kind: 'info' | 'error' } | null {
  if (!guide || guide.status === 'off') return null;
  if (sectionsFrom === 'guide') {
    const n = guide.cues.length;
    const lang = guide.language ? `, ${LANGUAGE[guide.language] ?? guide.language}` : '';
    return { text: `Sections placed from the guide track's spoken cues (${n} cue${n === 1 ? '' : 's'}${lang}).`, kind: 'info' };
  }
  const fallback = 'Sections came from the audio instead.';
  switch (guide.status) {
    case 'unavailable': {
      const why = (guide.message ?? 'speech recognition is not set up').replace(/\s*\(.*\)\s*$/, '');
      return { text: `Couldn't read the guide track: ${why}. ${fallback}`, kind: 'info' };
    }
    case 'error':
      return { text: `Couldn't read the guide track (${guide.message ?? 'unknown error'}). ${fallback}`, kind: 'error' };
    default:
      return { text: `Heard fewer than two section cues on the guide track. ${fallback}`, kind: 'info' };
  }
}
