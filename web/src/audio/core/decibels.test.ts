import { describe, expect, it } from 'vitest';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb, parseDb } from './decibels';

describe('decibels', () => {
  it('converts between gain and dB', () => {
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0)).toBe(-Infinity);
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(dbToGain(-Infinity)).toBe(0);
    expect(dbToGain(-12)).toBeCloseTo(0.2512, 4);
    expect(gainToDb(dbToGain(-17.3))).toBeCloseTo(-17.3, 9);
  });

  it('uses a console-style fader law', () => {
    expect(faderToDb(0)).toBe(-Infinity);
    expect(faderToDb(0.8)).toBe(0);
    expect(faderToDb(1)).toBe(6);
    expect(faderToDb(0.6)).toBe(-10);
    expect(faderToDb(0.5)).toBe(-15);
    expect(faderToDb(0.4)).toBe(-20);
    for (const db of [-80, -40, -20, -6, 0, 3, 6]) expect(faderToDb(dbToFader(db))).toBeCloseTo(db, 9);
    expect(dbToFader(-Infinity)).toBe(0);
    // half the travel is a big, audible change (unlike a linear-gain slider)
    expect(faderToDb(0.5)).toBeLessThan(-12);
  });

  it('formats and parses dB values', () => {
    expect(formatDb(0)).toBe('0.0 dB');
    expect(formatDb(-0.02)).toBe('0.0 dB');
    expect(formatDb(-6.02)).toBe('−6.0 dB');
    expect(formatDb(3.5)).toBe('+3.5 dB');
    expect(formatDb(-Infinity)).toBe('−∞ dB');
    expect(parseDb('-6')).toBe(-6);
    expect(parseDb('−12 dB')).toBe(-12);
    expect(parseDb('+3dB')).toBe(3);
    expect(parseDb('20')).toBe(6);
    expect(parseDb('-inf')).toBe(-Infinity);
    expect(parseDb('off')).toBe(-Infinity);
    expect(parseDb('loud')).toBeNull();
    expect(parseDb('')).toBeNull();
  });
});
