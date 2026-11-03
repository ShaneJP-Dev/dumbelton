/**
 * Which picked/dropped files are audio. Stems often arrive as folders that also
 * hold Ableton analysis files ("Drums.m4a.asd"), Ableton project files, or
 * macOS metadata ("._Drums.m4a", which looks like audio but is not).
 */

const AUDIO_EXT = /\.(wav|wave|mp3|m4a|mp4|aac|flac|ogg|oga|opus|aif|aiff|caf)$/i;
const ABLETON_ANALYSIS = /\.asd$/i;
const NOT_AUDIO = /\.(asd|als|alc|alp|adv|adg|txt|pdf|png|jpe?g|json|xml|ds_store)$/i;

export function isAudioFile(f: { name: string; type?: string }): boolean {
  const n = f.name;
  if (n.startsWith('.')) return false; // "._Drums.m4a" (macOS metadata) and other hidden files
  if (NOT_AUDIO.test(n)) return false;
  return AUDIO_EXT.test(n) || (f.type ?? '').startsWith('audio/');
}

export interface SortedFiles<F> {
  audio: F[];
  /** Ableton analysis files (.asd) that were skipped. */
  asd: number;
  /** Names of other non-audio files that were skipped. */
  other: string[];
}

export function sortFiles<F extends { name: string; type?: string }>(files: F[]): SortedFiles<F> {
  const out: SortedFiles<F> = { audio: [], asd: 0, other: [] };
  for (const f of files) {
    if (isAudioFile(f)) out.audio.push(f);
    else if (ABLETON_ANALYSIS.test(f.name)) out.asd++;
    else if (!f.name.startsWith('.')) out.other.push(f.name);
  }
  // stable, human order: "Bass", "Drums", "Keys"…
  out.audio.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return out;
}

/** A short note about what was left out, or null when nothing was. */
export function skippedMessage(s: SortedFiles<unknown>): string | null {
  const parts: string[] = [];
  if (s.asd) parts.push(`${s.asd} Ableton .asd file${s.asd === 1 ? '' : 's'} (analysis data, not audio)`);
  if (s.other.length) parts.push(`${s.other.length} other file${s.other.length === 1 ? '' : 's'}`);
  if (parts.length === 0) return null;
  if (s.audio.length === 0) {
    return s.asd
      ? 'No audio found. .asd files are Ableton analysis files; choose the audio files next to them (e.g. Drums.m4a, not Drums.m4a.asd).'
      : 'No audio files found (WAV, MP3, M4A, FLAC, AIFF, OGG).';
  }
  return `Skipped ${parts.join(' and ')}.`;
}

/** Top folder shared by files picked with a folder picker (webkitRelativePath), if any. */
export function commonFolder(files: { webkitRelativePath?: string }[]): string | null {
  const tops = new Set(files.map((f) => (f.webkitRelativePath ?? '').split('/')[0]).filter(Boolean));
  return tops.size === 1 ? [...tops][0] : null;
}

type Entry = FileSystemEntry;

function readAll(dir: FileSystemDirectoryEntry): Promise<Entry[]> {
  const reader = dir.createReader();
  const all: Entry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next(); // entries come in batches (Chrome: 100)
        }
      }, reject);
    next();
  });
}

async function walk(entry: Entry, out: File[], depth = 0): Promise<void> {
  if (entry.isFile) {
    const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push(f);
  } else if (entry.isDirectory && depth < 6) {
    for (const child of await readAll(entry as FileSystemDirectoryEntry)) await walk(child, out, depth + 1);
  }
}

/**
 * Files from a drop, including the contents of dropped folders.
 * Call it directly inside the drop handler: the browser only allows reading
 * the drop's items synchronously, so they are captured before the first await.
 */
export async function filesFromDrop(dt: DataTransfer): Promise<{ files: File[]; folder: string | null }> {
  const plain = Array.from(dt.files);
  const entries = Array.from(dt.items ?? [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.() ?? null)
    .filter((e): e is Entry => e !== null);
  if (entries.length === 0 || entries.every((e) => e.isFile)) return { files: plain, folder: null };
  const files: File[] = [];
  for (const e of entries) await walk(e, files);
  const dirs = entries.filter((e) => e.isDirectory);
  return { files, folder: entries.length === 1 && dirs.length === 1 ? dirs[0].name : null };
}
