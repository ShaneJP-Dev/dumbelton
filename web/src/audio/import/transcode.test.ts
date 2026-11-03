import { describe, expect, it } from 'vitest';
import { readRun, stemFromCompact } from '../core/StemBlocks';
import { BLOCK_FRAMES } from '../core/types';
import { computePeaks, pickLevel } from './peaks';
import { isEffectivelyMono, transcode } from './transcode';

describe('transcode', () => {
  it('stores identical L/R as mono and real stereo as stereo', () => {
    const n = 1000;
    const l = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 10) * 0.5);
    expect(transcode('a', [l, l.slice()]).compact.channels).toBe(1);
    const r = l.map((v) => v * 0.5);
    expect(isEffectivelyMono(l, r)).toBe(false);
    expect(transcode('b', [l, r]).compact.channels).toBe(2);
  });

  it('drops silent blocks and round-trips through the compact format', () => {
    const n = BLOCK_FRAMES * 3 + 100;
    const x = new Float32Array(n);
    for (let i = BLOCK_FRAMES * 2; i < n; i++) x[i] = Math.sin(i / 7) * 0.5;
    const { compact } = transcode('c', [x]);
    expect(Array.from(compact.present)).toEqual([0, 0, 1, 1]);
    expect(compact.data.byteLength).toBe((BLOCK_FRAMES + 100) * 2);
    const stem = stemFromCompact(compact);
    const L = new Float32Array(200);
    const R = new Float32Array(200);
    readRun(stem, BLOCK_FRAMES * 2 + 1000, 200, L, R, 0);
    for (let i = 0; i < 200; i++) expect(L[i]).toBeCloseTo(x[BLOCK_FRAMES * 2 + 1000 + i], 3);
    readRun(stem, 5000, 200, L, R, 0);
    expect(L.every((v) => v === 0)).toBe(true);
  });

  it('builds a peaks pyramid', () => {
    const x = new Float32Array(256 * 16).fill(0);
    x[300] = 1;
    x[5000] = -0.5;
    const levels = computePeaks([x]);
    expect(levels.length).toBe(4);
    expect(levels[0][3]).toBe(127); // bucket 1 max
    expect(levels[1][1]).toBe(127); // first coarse bucket max
    expect(pickLevel(100)).toBe(0);
    expect(pickLevel(5000)).toBe(2);
  });
});
