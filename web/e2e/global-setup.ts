import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SONG_DIR = resolve(here, '../../testdata/e2e');
/** An Ableton-style stems folder: .m4a stems, their .asd analysis files, a project file and macOS junk. */
export const M4A_DIR = resolve(SONG_DIR, 'Folder Song');
export const STEM_NAMES = ['drums', 'bass', 'keys', 'lead', 'click'];

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Generate the synthetic 5-stem song (known structure) once, plus an m4a copy when ffmpeg exists. */
export default function globalSetup(): void {
  if (!existsSync(resolve(SONG_DIR, 'structure.json'))) {
    execFileSync('uv', ['run', '--directory', '../analyzer', 'python', '../scripts/make_test_song.py', SONG_DIR], {
      cwd: resolve(here, '..'),
      stdio: 'inherit',
    });
  }
  if (!existsSync(resolve(M4A_DIR, 'click.m4a')) && hasFfmpeg()) {
    mkdirSync(M4A_DIR, { recursive: true });
    for (const n of STEM_NAMES) {
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', resolve(SONG_DIR, `${n}.wav`), '-c:a', 'aac', '-b:a', '192k', resolve(M4A_DIR, `${n}.m4a`)]);
      writeFileSync(resolve(M4A_DIR, `${n}.m4a.asd`), 'Ableton analysis data (not audio)');
    }
    writeFileSync(resolve(M4A_DIR, '._drums.m4a'), 'macOS metadata');
    writeFileSync(resolve(M4A_DIR, 'Folder Song.als'), 'Ableton project');
  }
}
