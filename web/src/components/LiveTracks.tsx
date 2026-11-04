import { useEffect, useRef, useState } from 'react';
import { LIVE_MUTE_HOLD_MS } from '../lib/stemParams';
import type { Stem } from '../lib/types';
import { setLiveMuted } from '../state/actions';
import { useApp } from '../state/store';
import { cx } from './ui';

/**
 * One track on the Live screen. Muting on stage must be deliberate: hold for
 * 3 seconds (a bar fills up; letting go early cancels). Unmuting is a tap.
 */
function LiveTrack({ stem, muted }: { stem: Stem; muted: boolean }) {
  const [progress, setProgress] = useState(0);
  const hold = useRef<{ start: number; raf: number } | null>(null);

  const cancel = () => {
    if (hold.current) cancelAnimationFrame(hold.current.raf);
    hold.current = null;
    setProgress(0);
  };
  useEffect(() => cancel, []);

  const start = () => {
    if (muted) {
      setLiveMuted(stem.id, false);
      return;
    }
    if (hold.current) return;
    const begin = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - begin) / LIVE_MUTE_HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        hold.current = null;
        setProgress(0);
        setLiveMuted(stem.id, true);
        (navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(60);
        return;
      }
      if (hold.current) hold.current.raf = requestAnimationFrame(step);
    };
    hold.current = { start: begin, raf: requestAnimationFrame(step) };
  };

  const secondsLeft = Math.ceil(((1 - progress) * LIVE_MUTE_HOLD_MS) / 1000);
  return (
    <button
      type="button"
      data-testid="live-track"
      data-name={stem.name}
      data-muted={muted}
      aria-pressed={muted}
      aria-label={muted ? `${stem.name} muted, tap to unmute` : `${stem.name}: hold for 3 seconds to mute`}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => (e.key === 'Enter' || e.key === ' ') && cancel()}
      style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
      className={cx(
        'relative h-12 min-w-28 touch-none select-none overflow-hidden rounded-xl px-3 text-left text-sm ring-1 transition-colors',
        muted ? 'bg-amber-500/90 text-black ring-amber-300' : 'bg-white/5 text-gray-100 ring-white/10 hover:bg-white/10',
      )}
    >
      {progress > 0 && (
        <span className="absolute inset-y-0 left-0 bg-red-600/60" style={{ width: `${progress * 100}%` }} aria-hidden="true" />
      )}
      <span className="relative flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: stem.color }} />
        <span className="truncate font-medium">{stem.name}</span>
      </span>
      <span className={cx('relative block text-[11px]', muted ? 'text-black/70' : 'text-gray-500')}>
        {muted ? 'Muted · tap to unmute' : progress > 0 ? `Muting in ${secondsLeft}…` : 'Hold to mute'}
      </span>
    </button>
  );
}

/** Every track, live: nothing muted when Live starts. */
export function LiveTracks({ stems }: { stems: Stem[] }) {
  const liveMuted = useApp((s) => s.liveMuted);
  return (
    <section className="mt-4" aria-label="Tracks">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Tracks</h3>
        <span className="text-xs text-gray-500">All tracks play in Live. Hold a track for 3 seconds to mute it.</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {stems.map((s) => (
          <LiveTrack key={s.id} stem={s} muted={liveMuted.includes(s.id)} />
        ))}
      </div>
    </section>
  );
}
