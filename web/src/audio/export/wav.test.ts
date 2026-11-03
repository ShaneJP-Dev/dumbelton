import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav } from './wav';

describe('wav', () => {
  it.each([16, 24] as const)('round-trips %i-bit stereo', (bits) => {
    const n = 1000;
    const l = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 20) * 0.8);
    const r = Float32Array.from({ length: n }, (_, i) => Math.cos(i / 30) * -0.5);
    const { sampleRate, channels } = decodeWav(encodeWav([l, r], 48000, bits));
    expect(sampleRate).toBe(48000);
    expect(channels.length).toBe(2);
    expect(channels[0].length).toBe(n);
    const tol = bits === 16 ? 1e-4 : 1e-6;
    for (let i = 0; i < n; i += 37) {
      expect(Math.abs(channels[0][i] - l[i])).toBeLessThan(tol);
      expect(Math.abs(channels[1][i] - r[i])).toBeLessThan(tol);
    }
  });

  it('clips instead of wrapping', () => {
    const { channels } = decodeWav(encodeWav([Float32Array.of(1.5, -1.5)], 48000, 16));
    expect(channels[0][0]).toBeCloseTo(1, 4);
    expect(channels[0][1]).toBeLessThan(-0.99);
  });
});
