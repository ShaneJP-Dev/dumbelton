import { describe, expect, it } from 'vitest';
import { allKeys, detectedKey, keyName, semitonesTo, transposedKey } from './musicKey';

describe('keys as letters', () => {
  it('names keys the way charts write them', () => {
    expect(allKeys(false).map((k) => k.name)).toEqual(['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']);
    expect(allKeys(true).map((k) => k.name)).toEqual(['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']);
  });

  it('moves a key by semitones, round the octave', () => {
    const g = { tonic: 7, minor: false };
    expect(keyName(transposedKey(g, 2))).toBe('A');
    expect(keyName(transposedKey(g, -1))).toBe('F#');
    expect(keyName(transposedKey(g, 5))).toBe('C');
    expect(keyName(transposedKey({ tonic: 4, minor: true }, -2))).toBe('Dm');
  });

  it('takes the smallest move to a chosen key (six apart goes down)', () => {
    expect(semitonesTo(7, 9)).toBe(2); // G -> A
    expect(semitonesTo(7, 2)).toBe(-5); // G -> D
    expect(semitonesTo(7, 0)).toBe(5); // G -> C
    expect(semitonesTo(0, 6)).toBe(-6); // C -> F#: down
    expect(semitonesTo(5, 5)).toBe(0);
  });

  it('reads the analyzer’s answer', () => {
    expect(detectedKey({ tonic: 9, mode: 'minor' })).toEqual({ tonic: 9, minor: true, source: 'detected' });
    expect(detectedKey(null)).toBeUndefined();
  });
});
