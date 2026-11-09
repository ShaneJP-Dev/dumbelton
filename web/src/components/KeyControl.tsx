import { useEffect, useState } from 'react';
import { AnalyzerUnavailable, findKey } from '../lib/analysis';
import { keyLabel, keyShort } from '../lib/keyChange';
import { allKeys, keyName, semitonesTo, transposedKey } from '../lib/musicKey';
import type { Project } from '../lib/types';
import { setOriginalKey, setTranspose, toast } from '../state/actions';
import { cx } from './ui';

/** "Key G" (or "Key A +2"), semitone steps, and a menu to pick the key to play in. */
export function KeyControl({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const t = project.transpose ?? 0;
  const k = project.key;
  const playing = k ? transposedKey(k, t) : null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const find = async () => {
    setFinding(true);
    try {
      const name = await findKey(project);
      toast(name ? `This song is in ${name}. Change it below if that's wrong.` : "Couldn't hear a clear key. Choose it below.");
    } catch (err) {
      toast(
        err instanceof AnalyzerUnavailable ? 'The analysis server is not running. Start the app with pnpm start, or choose the key below.' : String((err as Error).message ?? err),
        'error',
      );
    } finally {
      setFinding(false);
    }
  };

  return (
    <div className="relative flex items-center rounded-lg bg-white/10 text-sm" role="group" aria-label="Key">
      <button
        type="button"
        data-testid="key-name"
        onClick={() => setOpen(!open)}
        title={k ? `Original key ${keyName(k)}; playing ${keyLabel(t)}. Tap to choose a key.` : 'Tap to find or set the song’s key'}
        className="flex h-10 items-center gap-1 rounded-md pl-2 pr-1 hover:bg-white/10"
      >
        <span className="text-gray-400">Key</span>
        <span data-testid="key-value" className={cx('min-w-6 text-center font-semibold tabular-nums', t !== 0 && 'text-amber-300')}>
          {playing ? keyName(playing) : keyShort(t)}
        </span>
        {playing && t !== 0 && <span className="text-xs text-amber-300/80 tabular-nums">{keyShort(t)}</span>}
      </button>
      <button
        type="button"
        data-testid="key-down"
        aria-label="Key down a semitone"
        disabled={t <= -6}
        onClick={() => setTranspose(t - 1)}
        className="h-10 w-8 rounded-md text-lg leading-none text-gray-200 hover:bg-white/10 disabled:opacity-30"
      >
        −
      </button>
      <button
        type="button"
        data-testid="key-up"
        aria-label="Key up a semitone"
        disabled={t >= 6}
        onClick={() => setTranspose(t + 1)}
        className="h-10 w-8 rounded-md text-lg leading-none text-gray-200 hover:bg-white/10 disabled:opacity-30"
      >
        +
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            className="absolute bottom-full right-0 z-50 mb-2 w-80 rounded-xl bg-[#1a1f2c] p-3 shadow-2xl ring-1 ring-white/10"
            data-testid="key-menu"
            role="dialog"
            aria-label="Key"
          >
            {k ? (
              <>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Play in</div>
                <div className="grid grid-cols-6 gap-1">
                  {allKeys(k.minor).map((key) => {
                    const current = playing?.tonic === key.tonic;
                    const original = k.tonic === key.tonic;
                    return (
                      <button
                        key={key.name}
                        type="button"
                        data-testid="play-in"
                        data-key={key.name}
                        aria-pressed={current}
                        onClick={() => setTranspose(semitonesTo(k.tonic, key.tonic))}
                        className={cx(
                          'relative h-9 rounded-md text-sm font-medium',
                          current ? 'bg-white text-black' : 'bg-white/5 text-gray-200 hover:bg-white/15',
                        )}
                        title={original ? 'Original key' : `${keyLabel(semitonesTo(k.tonic, key.tonic))}`}
                      >
                        {key.name}
                        {original && <span className={cx('absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full', current ? 'bg-black' : 'bg-amber-300')} />}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[11px] text-gray-500">The dot marks the original key. Same tempo in every key; up to 6 semitones either way.</p>
              </>
            ) : (
              <p className="mb-2 text-sm text-gray-300">The app doesn't know this song's key yet, so it shows semitones. Find it or choose it:</p>
            )}
            <label className="mt-3 flex items-center gap-2 text-sm">
              <span className="text-gray-400">Original key</span>
              <select
                data-testid="original-key"
                value={k ? `${k.tonic}${k.minor ? 'm' : ''}` : ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setOriginalKey(v ? { tonic: Number.parseInt(v, 10), minor: v.endsWith('m'), source: 'set' } : undefined);
                }}
                className="h-9 flex-1 rounded-md bg-white/10 px-2"
              >
                <option value="" className="bg-[#151924]">
                  Not set
                </option>
                {[...allKeys(false), ...allKeys(true)].map((key) => (
                  <option key={key.name} value={`${key.tonic}${key.minor ? 'm' : ''}`} className="bg-[#151924]">
                    {key.name}
                  </option>
                ))}
              </select>
            </label>
            {k?.source === 'detected' && <p className="mt-1 text-[11px] text-gray-500">Detected from the audio: change it if it's wrong.</p>}
            {!k && (
              <button
                type="button"
                data-testid="find-key"
                disabled={finding}
                onClick={() => void find()}
                className="mt-3 h-9 w-full rounded-md bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
              >
                {finding ? 'Listening…' : 'Find the key from the audio'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
