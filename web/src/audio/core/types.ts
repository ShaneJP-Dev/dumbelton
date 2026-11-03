/** Integer frame index at SAMPLE_RATE. All positions in the engine are source frames. */
export type Frame = number;

export const SAMPLE_RATE = 48000;
/** Stems are stored in fixed-size blocks so silent blocks cost nothing. */
export const BLOCK_SHIFT = 16;
export const BLOCK_FRAMES = 1 << BLOCK_SHIFT; // 65536
export const BLOCK_MASK = BLOCK_FRAMES - 1;

/** Length of the equal-power crossfade at every join / jump (10 ms). */
export const XFADE_FRAMES = 480;
/** Gain ramps for mute/solo/volume and play/pause (5 ms). */
export const RAMP_FRAMES = 240;

export type Quantize = 'now' | 'nextBar' | 'segmentEnd';

export interface Segment {
  id: string;
  start: Frame;
  end: Frame;
}

/**
 * What to play. Linear playback is one segment; a practice loop is one segment
 * with loop=true; an arrangement is an ordered list; live is the song's sections.
 */
export interface Program {
  segments: Segment[];
  loop: boolean;
}

export interface StemPcm {
  id: string;
  channels: 1 | 2;
  length: Frame;
  /** Interleaved Int16 per block (BLOCK_FRAMES * channels samples; the last may be shorter). null = silence. */
  blocks: (Int16Array | null)[];
}

export interface SongPcm {
  id: string;
  length: Frame;
  stems: StemPcm[];
}

export interface Grid {
  beats: Frame[];
  downbeats: Frame[];
}

export type Bus = 'main' | 'cue';

export interface StemParams {
  gain: number; // linear
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  bus: Bus;
}

export interface CorePosition {
  frame: Frame;
  segment: number;
  playing: boolean;
  pending: { at: Frame; to: number } | null;
}

export type CoreEvent =
  | { type: 'armed'; at: Frame; to: number }
  | { type: 'jumped'; to: number; frame: Frame }
  | { type: 'segment'; index: number }
  | { type: 'ended' };
