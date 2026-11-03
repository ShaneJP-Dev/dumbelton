import { compactStem, stemFromFloat, type CompactStem } from '../core/StemBlocks';
import { computePeaks } from './peaks';

/** -80 dBFS: below this, L and R are treated as identical (mono). */
const MONO_THRESHOLD = 1e-4;

export function isEffectivelyMono(l: Float32Array, r: Float32Array): boolean {
  const n = Math.min(l.length, r.length);
  for (let i = 0; i < n; i++) if (Math.abs(l[i] - r[i]) > MONO_THRESHOLD) return false;
  return true;
}

export interface TranscodeResult {
  compact: CompactStem;
  peaks: Int8Array[];
}

/** Float channels at 48 kHz -> compact Int16 blocks (+ peaks). Pure: used by the worker and tests. */
export function transcode(id: string, channels: Float32Array[]): TranscodeResult {
  let chans = channels.slice(0, 2);
  if (chans.length === 2 && isEffectivelyMono(chans[0], chans[1])) {
    const m = new Float32Array(chans[0].length);
    for (let i = 0; i < m.length; i++) m[i] = 0.5 * (chans[0][i] + chans[1][i]);
    chans = [m];
  }
  const peaks = computePeaks(chans);
  const stem = stemFromFloat(id, chans, { dither: true });
  return { compact: compactStem(stem), peaks };
}
