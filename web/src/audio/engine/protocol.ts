import type { CompactStem } from '../core/StemBlocks';
import type { ClickParams } from '../core/RenderCore';
import type { CoreEvent, Frame, Grid, Program, Quantize, StemParams } from '../core/types';

export interface WireSong {
  id: string;
  length: Frame;
  stems: CompactStem[];
}

export type ToWorklet =
  | { type: 'load'; slot: number; song: WireSong; grid: Grid }
  | { type: 'activate'; slot: number }
  | { type: 'unload'; slot: number }
  | { type: 'play'; countIn?: boolean }
  | { type: 'pause' }
  | { type: 'seek'; frame: Frame; segment?: number }
  | { type: 'program'; program: Program }
  | { type: 'jump'; to: number; q: Quantize }
  | { type: 'cancelJump' }
  | { type: 'stem'; index: number; params: Partial<StemParams> }
  | { type: 'click'; params: Partial<ClickParams> }
  | { type: 'speed'; speed: number }
  | { type: 'grid'; grid: Grid };

export interface PosReport {
  type: 'pos';
  frame: Frame;
  segment: number;
  playing: boolean;
  pending: { at: Frame; to: number } | null;
  time: number; // AudioContext time at the end of the reported block
  speed: number;
  songId: string | null;
}

export type FromWorklet =
  | PosReport
  | { type: 'event'; event: CoreEvent; songId: string | null }
  | { type: 'loaded'; slot: number; songId: string }
  | { type: 'activated'; slot: number; songId: string | null };
