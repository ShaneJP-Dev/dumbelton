import { BLOCK_FRAMES, BLOCK_MASK, BLOCK_SHIFT, type Frame, type StemPcm } from './types';

const I16 = 1 / 32768;

/** Read one sample (channel c) of a stem at frame f. Out of range or silent -> 0. */
export function sampleAt(stem: StemPcm, f: Frame, c: number): number {
  if (f < 0 || f >= stem.length) return 0;
  const blk = stem.blocks[f >>> BLOCK_SHIFT];
  if (blk === null || blk === undefined) return 0;
  const ch = stem.channels;
  return blk[(f & BLOCK_MASK) * ch + (ch === 2 ? c : 0)] * I16;
}

/**
 * Copy `count` frames of a stem starting at `from` into dstL/dstR at `off`.
 * Mono stems are written to both channels. Handles block boundaries and silence.
 */
export function readRun(
  stem: StemPcm,
  from: Frame,
  count: number,
  dstL: Float32Array,
  dstR: Float32Array,
  off: number,
): void {
  let f = from;
  let i = off;
  const end = off + count;
  const ch = stem.channels;
  while (i < end) {
    if (f < 0 || f >= stem.length) {
      // run of out-of-range frames
      const n = f < 0 ? Math.min(end - i, -f) : end - i;
      dstL.fill(0, i, i + n);
      dstR.fill(0, i, i + n);
      i += n;
      f += n;
      continue;
    }
    const b = f >>> BLOCK_SHIFT;
    const inBlock = f & BLOCK_MASK;
    const n = Math.min(end - i, BLOCK_FRAMES - inBlock, stem.length - f);
    const blk = stem.blocks[b];
    if (!blk) {
      dstL.fill(0, i, i + n);
      dstR.fill(0, i, i + n);
    } else if (ch === 1) {
      for (let k = 0; k < n; k++) {
        const v = blk[inBlock + k] * I16;
        dstL[i + k] = v;
        dstR[i + k] = v;
      }
    } else {
      let j = inBlock * 2;
      for (let k = 0; k < n; k++, j += 2) {
        dstL[i + k] = blk[j] * I16;
        dstR[i + k] = blk[j + 1] * I16;
      }
    }
    i += n;
    f += n;
  }
}

/** Build a StemPcm from planar float channels (used by import and tests). Silent blocks become null. */
export function stemFromFloat(
  id: string,
  channels: Float32Array[],
  opts: { dither?: boolean; silenceThreshold?: number } = {},
): StemPcm {
  const ch = channels.length === 1 ? 1 : 2;
  const length = channels[0].length;
  const nBlocks = Math.ceil(length / BLOCK_FRAMES);
  const thr = opts.silenceThreshold ?? 2 / 32768;
  const blocks: (Int16Array | null)[] = [];
  for (let b = 0; b < nBlocks; b++) {
    const start = b * BLOCK_FRAMES;
    const n = Math.min(BLOCK_FRAMES, length - start);
    let peak = 0;
    for (let c = 0; c < ch; c++) {
      const x = channels[c];
      for (let k = 0; k < n; k++) {
        const a = Math.abs(x[start + k]);
        if (a > peak) peak = a;
      }
    }
    if (peak < thr) {
      blocks.push(null);
      continue;
    }
    const out = new Int16Array(n * ch);
    for (let c = 0; c < ch; c++) {
      const x = channels[c];
      for (let k = 0; k < n; k++) {
        let v = x[start + k] * 32767;
        if (opts.dither) v += Math.random() - Math.random(); // TPDF, +-1 LSB
        out[k * ch + c] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
      }
    }
    blocks.push(out);
  }
  return { id, channels: ch, length, blocks };
}

/** Bytes held in memory by a stem (for the memory budget). */
export function stemBytes(stem: StemPcm): number {
  let n = 0;
  for (const b of stem.blocks) if (b) n += b.byteLength;
  return n;
}

/**
 * Compact storage: only non-silent blocks, concatenated. `present[b]` = 1 when
 * block b is stored. This is both the on-disk format and what is transferred
 * to the worklet (one ArrayBuffer per stem, so the transfer is zero-copy).
 */
export interface CompactStem {
  id: string;
  channels: 1 | 2;
  length: Frame;
  present: Uint8Array;
  data: ArrayBuffer;
}

export function compactStem(stem: StemPcm): CompactStem {
  const present = new Uint8Array(stem.blocks.length);
  let bytes = 0;
  stem.blocks.forEach((b, i) => {
    if (b) {
      present[i] = 1;
      bytes += b.byteLength;
    }
  });
  const data = new ArrayBuffer(bytes);
  const view = new Int16Array(data);
  let off = 0;
  for (const b of stem.blocks) {
    if (b) {
      view.set(b, off);
      off += b.length;
    }
  }
  return { id: stem.id, channels: stem.channels, length: stem.length, present, data };
}

export function stemFromCompact(c: CompactStem): StemPcm {
  const blocks: (Int16Array | null)[] = [];
  let off = 0;
  const nBlocks = c.present.length;
  for (let b = 0; b < nBlocks; b++) {
    if (!c.present[b]) {
      blocks.push(null);
      continue;
    }
    const frames = Math.min(BLOCK_FRAMES, c.length - b * BLOCK_FRAMES);
    const n = frames * c.channels;
    blocks.push(new Int16Array(c.data, off * 2, n));
    off += n;
  }
  return { id: c.id, channels: c.channels, length: c.length, blocks };
}
