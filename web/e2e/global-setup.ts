import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SONG_DIR = resolve(here, '../../testdata/e2e');

/** Generate the synthetic 5-stem song (known structure) once. */
export default function globalSetup(): void {
  if (existsSync(resolve(SONG_DIR, 'structure.json'))) return;
  execFileSync('uv', ['run', '--directory', '../analyzer', 'python', '../scripts/make_test_song.py', SONG_DIR], {
    cwd: resolve(here, '..'),
    stdio: 'inherit',
  });
}
