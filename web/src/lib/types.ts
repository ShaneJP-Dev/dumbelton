import type { Bus, Frame } from '../audio/core/types';

export type SectionKind =
  | 'intro'
  | 'verse'
  | 'pre-chorus'
  | 'chorus'
  | 'bridge'
  | 'solo'
  | 'inst'
  | 'break'
  | 'interlude'
  | 'tag'
  | 'vamp'
  | 'outro';

export interface Stem {
  id: string;
  name: string;
  color: string;
  channels: 1 | 2;
  length: Frame;
  /** Block map of the compact PCM file (1 = block stored, 0 = silence). */
  present: Uint8Array;
  /** Bytes of PCM held in memory when loaded. */
  bytes: number;
  gain: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  bus: Bus;
  inAnalysisMix: boolean;
}

export interface Section {
  id: string;
  kind: SectionKind;
  name: string;
  start: Frame;
  end: Frame;
}

export interface ArrangementItem {
  id: string;
  sectionId: string;
}

export interface Arrangement {
  id: string;
  name: string;
  items: ArrangementItem[];
}

export interface AnalysisState {
  status: 'none' | 'running' | 'done' | 'error';
  backend?: string;
  error?: string;
  progress?: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lengthFrames: Frame;
  bpm: number;
  beats: Frame[];
  downbeats: Frame[];
  stems: Stem[];
  sections: Section[];
  arrangements: Arrangement[];
  analysis: AnalysisState;
}

export interface SetlistEntry {
  id: string;
  projectId: string;
  arrangementId?: string;
}

export interface Setlist {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  entries: SetlistEntry[];
}

export interface PeaksRecord {
  stemId: string;
  songId: string;
  /** Interleaved min,max Int8 per bucket; level k has buckets of PEAK_BASE * 4^k frames. */
  levels: Int8Array[];
}
