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

export interface StemParams {
  gain: number; // linear
  pan: number; // -1..1 (applies to stereo destinations)
  mute: boolean;
  solo: boolean;
}

/** Most output channels the engine renders (Chrome sends up to 32 to one device). */
export const MAX_OUTPUTS = 32;

/** Where audio goes: a stereo pair, or one channel (a stereo stem is summed to mono). 0-based. */
export type Dest = { l: number; r: number } | { ch: number };

/** Output routing: destinations for each stem (a stem may feed several), the click's and the spoken cues' channels. */
export interface Routing {
  stems: Dest[][];
  click: number[];
  /** Spoken cues (the Guide channel). Missing = the click's channels. */
  cue?: number[];
}

/** Everything on output channels 1-2. */
export function stereoRouting(stems: number): Routing {
  return { stems: Array.from({ length: stems }, () => [{ l: 0, r: 1 }]), click: [0, 1], cue: [0, 1] };
}

/**
 * What a 2-channel device (a laptop) plays when the outputs are laid out for a
 * multichannel desk: the full stereo mix, or one channel on both sides.
 */
export type Monitor = { kind: 'mix' } | { kind: 'channel'; ch: number };

/** Spoken cues in Live ("Chorus" a bar before the chorus). */
export interface CueParams {
  enabled: boolean;
  /** Clip to say before each program segment (index into the clips), -1 = nothing. */
  segClip: number[];
  /** Speak on the song's own flow too (no guide track), not only before jumps. */
  natural: boolean;
  /** Stems of the song's own guide track, silenced while a jump's cue plays. */
  guideStems: number[];
  gain: number;
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
  | { type: 'repeat'; on: boolean }
  | { type: 'ended' };
