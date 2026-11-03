/**
 * Volume in decibels, and a console-style fader law.
 * Stem gain is stored linear (1 = 0 dB); the UI works in dB.
 */

export const MAX_DB = 6;
export const MIN_DB = -90;

export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

export function dbToGain(db: number): number {
  return db === -Infinity ? 0 : Math.pow(10, db / 20);
}

/**
 * Fader position (0..1) -> dB, piecewise linear between console-like marks:
 * 0 dB sits at 80 % of the travel, the bottom fifth fades to silence, and the
 * very bottom is off (-inf). A linear-gain slider, by contrast, spends most of
 * its travel within a few dB of full volume.
 */
const KNOTS: [number, number][] = [
  [0, MIN_DB],
  [0.05, -60],
  [0.2, -40],
  [0.4, -20],
  [0.6, -10],
  [0.8, 0],
  [1, MAX_DB],
];

export function faderToDb(pos: number): number {
  if (pos <= 0) return -Infinity;
  if (pos >= 1) return MAX_DB;
  for (let i = 1; i < KNOTS.length; i++) {
    const [p1, d1] = KNOTS[i];
    if (pos <= p1) {
      const [p0, d0] = KNOTS[i - 1];
      return d0 + ((pos - p0) / (p1 - p0)) * (d1 - d0);
    }
  }
  return MAX_DB;
}

export function dbToFader(db: number): number {
  if (db === -Infinity || db <= MIN_DB) return 0;
  if (db >= MAX_DB) return 1;
  for (let i = 1; i < KNOTS.length; i++) {
    const [p1, d1] = KNOTS[i];
    if (db <= d1) {
      const [p0, d0] = KNOTS[i - 1];
      return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
    }
  }
  return 1;
}

const MINUS = '−';

/** "0.0 dB", "−6.0 dB", "+3.5 dB", "−∞ dB" */
export function formatDb(db: number): string {
  if (db === -Infinity || db < MIN_DB - 30) return `${MINUS}∞ dB`;
  const r = Math.round(db * 10) / 10;
  if (r === 0) return '0.0 dB';
  return `${r > 0 ? '+' : MINUS}${Math.abs(r).toFixed(1)} dB`;
}

/** Parse what someone types: "-6", "−6 dB", "+3", "0", "-inf", "off". null if not a number. Clamped to +6 dB. */
export function parseDb(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/−/g, '-').replace(/db$/, '').trim();
  if (t === '') return null;
  if (/^-?(inf|infinity|∞)$/.test(t) || t === 'off') return -Infinity;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_DB, n);
}
