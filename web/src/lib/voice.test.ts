import { describe, expect, it } from 'vitest';
import { parseWav, toEngineRate } from './voice';

function wav(samples: number[][], rate: number, bits: 16 | 32, float = false): ArrayBuffer {
  const channels = samples.length;
  const frames = samples[0].length;
  const bytes = bits / 8;
  const data = frames * channels * bytes;
  const buf = new ArrayBuffer(44 + 8 + data);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, buf.byteLength - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, float ? 3 : 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * bytes, true);
  v.setUint16(32, channels * bytes, true);
  v.setUint16(34, bits, true);
  str(36, 'LIST'); // an extra chunk before the audio, as some tools write
  v.setUint32(40, 0, true);
  str(44, 'data');
  v.setUint32(48, data, true);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const o = 52 + (f * channels + c) * bytes;
      if (float) v.setFloat32(o, samples[c][f], true);
      else v.setInt16(o, Math.round(samples[c][f] * 32767), true);
    }
  }
  return buf;
}

describe('parseWav', () => {
  it('reads 16-bit PCM, skipping other chunks, and mixes stereo to mono', () => {
    const { rate, samples } = parseWav(wav([[0.5, -0.5, 0.25], [0.5, 0.5, 0.25]], 22050, 16));
    expect(rate).toBe(22050);
    expect(Array.from(samples).map((x) => Math.round(x * 1000) / 1000)).toEqual([0.5, 0, 0.25]);
  });

  it('reads 32-bit float', () => {
    const { samples } = parseWav(wav([[0.125, -1]], 48000, 32, true));
    expect(Array.from(samples)).toEqual([0.125, -1]);
  });

  it('rejects files that are not WAV', () => {
    expect(() => parseWav(new TextEncoder().encode('hello world!').buffer)).toThrow(/not a WAV/);
  });
});

describe('toEngineRate', () => {
  it('leaves 48 kHz alone and resamples other rates to the same duration', () => {
    const x = new Float32Array([0, 1, 0, -1]);
    expect(toEngineRate(x, 48000)).toBe(x);
    const up = toEngineRate(new Float32Array(24000).fill(0.5), 24000);
    expect(up.length).toBe(48000);
    expect(up[1000]).toBeCloseTo(0.5, 6);
  });
});
