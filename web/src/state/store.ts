import { create } from 'zustand';
import type { Quantize } from '../audio/core/types';
import type { SnapMode } from '../lib/sections';
import type { Project, Setlist } from '../lib/types';

export type Mode = 'practice' | 'arrange' | 'live';

export type Route =
  | { name: 'library' }
  | { name: 'song'; id: string }
  | { name: 'setlists' }
  | { name: 'setlist'; id: string };

export interface Transport {
  playing: boolean;
  segment: number;
  pending: { at: number; to: number } | null;
}

export interface AppState {
  route: Route;
  projects: Project[];
  setlists: Setlist[];
  current: Project | null;
  mode: Mode;
  speed: number;
  click: boolean;
  countIn: boolean;
  loop: boolean;
  selected: string | null;
  quantize: Exclude<Quantize, 'now'>;
  snap: SnapMode;
  arrangementId: string | null;
  transport: Transport;
  /** When playing a setlist in Live mode. */
  live: { setlistId: string; index: number } | null;
  toast: { text: string; kind: 'info' | 'error' } | null;
  engineError: string | null;
}

export const useApp = create<AppState>(() => ({
  route: { name: 'library' },
  projects: [],
  setlists: [],
  current: null,
  mode: 'practice',
  speed: 1,
  click: false,
  countIn: false,
  loop: false,
  selected: null,
  quantize: 'segmentEnd',
  snap: 'bar',
  arrangementId: null,
  transport: { playing: false, segment: 0, pending: null },
  live: null,
  toast: null,
  engineError: null,
}));

export const getState = useApp.getState;
export const setState = useApp.setState;
