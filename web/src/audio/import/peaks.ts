/** Waveform peaks pyramid: min/max per bucket, Int8, interleaved. */
export const PEAK_BASE = 256; // frames per bucket at level 0
export const PEAK_LEVELS = 4; // 256, 1024, 4096, 16384

export function computePeaks(channels: Float32Array[]): Int8Array[] {
  const len = channels[0].length;
  const n0 = Math.ceil(len / PEAK_BASE);
  const l0 = new Int8Array(n0 * 2);
  for (let b = 0; b < n0; b++) {
    let mn = 0;
    let mx = 0;
    const s = b * PEAK_BASE;
    const e = Math.min(len, s + PEAK_BASE);
    for (const ch of channels) {
      for (let i = s; i < e; i++) {
        const v = ch[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    l0[b * 2] = Math.max(-127, Math.round(mn * 127));
    l0[b * 2 + 1] = Math.min(127, Math.round(mx * 127));
  }
  const levels = [l0];
  for (let k = 1; k < PEAK_LEVELS; k++) {
    const prev = levels[k - 1];
    const np = prev.length / 2;
    const n = Math.ceil(np / 4);
    const out = new Int8Array(n * 2);
    for (let b = 0; b < n; b++) {
      let mn = 0;
      let mx = 0;
      for (let j = b * 4; j < Math.min(np, b * 4 + 4); j++) {
        if (prev[j * 2] < mn) mn = prev[j * 2];
        if (prev[j * 2 + 1] > mx) mx = prev[j * 2 + 1];
      }
      out[b * 2] = mn;
      out[b * 2 + 1] = mx;
    }
    levels.push(out);
  }
  return levels;
}

/** Pick the coarsest level whose bucket is no larger than `framesPerPixel`. */
export function pickLevel(framesPerPixel: number): number {
  let k = 0;
  while (k + 1 < PEAK_LEVELS && PEAK_BASE * 4 ** (k + 1) <= framesPerPixel) k++;
  return k;
}
