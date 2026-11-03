import { stemFromFloat } from './StemBlocks';
import type { SongPcm } from './types';

export const PERIOD = 4096;

/** A stem whose sample value encodes (frame % PERIOD), so tests can read back positions. */
export function rampStem(id: string, length: number, channels: 1 | 2 = 2) {
  const ch = Array.from({ length: channels }, () => new Float32Array(length));
  for (let f = 0; f < length; f++) {
    const v = ((f % PERIOD) / PERIOD) * 0.9 - 0.45 + 0.0001;
    for (const c of ch) c[f] = v;
  }
  return stemFromFloat(id, ch, { silenceThreshold: 0 });
}

export function decode(v: number): number {
  return Math.round(((v + 0.45 - 0.0001) / 0.9) * PERIOD) % PERIOD;
}

export function sineStem(id: string, length: number, freq: number, amp = 0.5, sampleRate = 48000) {
  const x = new Float32Array(length);
  for (let f = 0; f < length; f++) x[f] = amp * Math.sin((2 * Math.PI * freq * f) / sampleRate);
  return stemFromFloat(id, [x], { silenceThreshold: 0 });
}

export function song(stems: ReturnType<typeof rampStem>[], length: number): SongPcm {
  return { id: 'song', length, stems };
}

export function buffers(n: number, stems: number) {
  return {
    main: [new Float32Array(n), new Float32Array(n)],
    stemOuts: Array.from({ length: stems }, () => [new Float32Array(n), new Float32Array(n)]),
  };
}
