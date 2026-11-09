/** "+2 semitones", "−1 semitone", or "original key". */
export function keyLabel(t: number): string {
  if (t === 0) return 'original key';
  const n = Math.abs(t);
  return `${t > 0 ? '+' : '−'}${n} semitone${n === 1 ? '' : 's'}`;
}

/** Compact form for the transport: "+2", "−1", "0". */
export function keyShort(t: number): string {
  return t === 0 ? '0' : `${t > 0 ? '+' : '−'}${Math.abs(t)}`;
}
