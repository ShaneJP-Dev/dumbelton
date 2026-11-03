/** Guess friendly stem names and colours from file names. */

const COLORS: [RegExp, string][] = [
  [/click|metronome|count|cue|guide/i, '#6b7280'],
  [/kick|snare|drum|perc|hat|tom|cymbal|loop/i, '#ef4444'],
  [/bass|sub|808/i, '#8b5cf6'],
  [/key|piano|rhodes|organ|synth|pad|wurli/i, '#eab308'],
  [/vox|vocal|voice|bgv|choir|lead.?v|harmony/i, '#ec4899'],
  [/gtr|guitar|ac\.?g|eg\b|electric/i, '#f97316'],
  [/string|violin|cello|orch|brass|horn/i, '#14b8a6'],
];
const PALETTE = ['#3b82f6', '#22c55e', '#06b6d4', '#a3e635', '#f43f5e', '#c084fc', '#fb923c', '#2dd4bf'];

export function stemColor(name: string, index: number): string {
  for (const [re, c] of COLORS) if (re.test(name)) return c;
  return PALETTE[index % PALETTE.length];
}

/** Stems that should not drive structure analysis (or be heard by default on stage mixes). */
export function isGuideStem(name: string): boolean {
  return /click|metronome|count.?in|\bcue|guide/i.test(name);
}

function stripExt(n: string): string {
  return n.replace(/\.[a-z0-9]{2,5}$/i, '');
}

/** Remove the prefix shared by every file name ("My Song - Drums.wav" -> "Drums"). */
export function stemNamesFromFiles(fileNames: string[]): string[] {
  const bases = fileNames.map(stripExt);
  if (bases.length < 2) return bases.map((b) => b.trim() || 'Track');
  let prefix = bases[0];
  for (const b of bases) {
    let i = 0;
    while (i < prefix.length && i < b.length && prefix[i] === b[i]) i++;
    prefix = prefix.slice(0, i);
  }
  // only cut at a separator so "Bass" and "Bells" keep their first letter
  const cut = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('-'), prefix.lastIndexOf('_'), prefix.lastIndexOf('.'));
  const p = cut >= 0 ? prefix.slice(0, cut + 1) : '';
  return bases.map((b) => b.slice(p.length).replace(/^[\s\-_.]+/, '').trim() || b.trim() || 'Track');
}

/** Suggest a song name from the shared file-name prefix. */
export function songNameFromFiles(fileNames: string[]): string {
  const bases = fileNames.map(stripExt);
  if (bases.length === 0) return 'New song';
  let prefix = bases[0];
  for (const b of bases) {
    let i = 0;
    while (i < prefix.length && i < b.length && prefix[i] === b[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const name = prefix.replace(/[\s\-_.]+$/, '').trim();
  return name.length >= 3 ? name : 'New song';
}
