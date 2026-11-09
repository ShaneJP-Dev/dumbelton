/** Musical keys as letters (the way worship charts write them). */

export interface SongKey {
  /** 0 = C … 11 = B */
  tonic: number;
  minor: boolean;
  /** Found in the audio, or chosen by hand (then analysis never replaces it). */
  source: 'detected' | 'set';
}

const MAJOR = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

export const mod12 = (n: number) => ((n % 12) + 12) % 12;

export function keyName(k: { tonic: number; minor: boolean }): string {
  return (k.minor ? MINOR : MAJOR)[mod12(k.tonic)];
}

/** The key a song sounds in after moving it by `semitones`. */
export function transposedKey(k: { tonic: number; minor: boolean }, semitones: number): { tonic: number; minor: boolean } {
  return { tonic: mod12(k.tonic + semitones), minor: k.minor };
}

/** The smallest move from one key to another: -6…+5 (six apart goes down). */
export function semitonesTo(fromTonic: number, toTonic: number): number {
  const d = mod12(toTonic - fromTonic);
  return d >= 6 ? d - 12 : d;
}

/** The 12 keys of one kind, C first. */
export function allKeys(minor: boolean): { tonic: number; minor: boolean; name: string }[] {
  return Array.from({ length: 12 }, (_, tonic) => ({ tonic, minor, name: keyName({ tonic, minor }) }));
}

/** The analyzer's answer as a song key. */
export function detectedKey(k: { tonic: number; mode: string } | null | undefined): SongKey | undefined {
  return k ? { tonic: mod12(k.tonic), minor: k.mode === 'minor', source: 'detected' } : undefined;
}
