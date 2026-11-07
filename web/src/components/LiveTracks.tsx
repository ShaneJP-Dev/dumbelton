import { useEffect, useRef, useState } from 'react';
import { groupForStem, type OutputGroup } from '../lib/outputs';
import { LIVE_MUTE_ALL_HOLD_MS, liveMuteReason } from '../lib/stemParams';
import type { Stem } from '../lib/types';
import { setLiveMuteAll, toggleLiveGroup, toggleLiveTrack } from '../state/actions';
import { liveMutes } from '../state/engine';
import { useApp } from '../state/store';
import { cx } from './ui';

/** Press and hold for `ms` to run `onDone`; letting go early cancels. `progress` runs 0..1 while held. */
function useHold(ms: number, onDone: () => void) {
  const [progress, setProgress] = useState(0);
  const hold = useRef<number | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  const cancel = () => {
    if (hold.current !== null) cancelAnimationFrame(hold.current);
    hold.current = null;
    setProgress(0);
  };
  useEffect(() => cancel, []);

  const start = () => {
    if (hold.current !== null) return;
    const begin = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - begin) / ms);
      setProgress(p);
      if (p >= 1) {
        hold.current = null;
        setProgress(0);
        done.current();
        (navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(60);
        return;
      }
      if (hold.current !== null) hold.current = requestAnimationFrame(step);
    };
    hold.current = requestAnimationFrame(step);
  };

  const handlers = {
    onPointerDown: start,
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        start();
      }
    },
    onKeyUp: (e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && cancel(),
  };
  return { progress, handlers };
}

/** Hold 2 s to silence everything (the song keeps playing); tap to bring it all back. */
function MuteAllButton({ on }: { on: boolean }) {
  const { progress, handlers } = useHold(LIVE_MUTE_ALL_HOLD_MS, () => setLiveMuteAll(true));
  if (on) {
    return (
      <button
        type="button"
        data-testid="live-mute-all"
        data-muted="true"
        aria-pressed="true"
        onClick={() => setLiveMuteAll(false)}
        className="h-12 rounded-xl bg-red-600 px-4 text-sm font-semibold text-white ring-1 ring-red-300 hover:bg-red-500"
      >
        All muted · tap to unmute
      </button>
    );
  }
  const secondsLeft = Math.ceil(((1 - progress) * LIVE_MUTE_ALL_HOLD_MS) / 1000);
  return (
    <button
      type="button"
      data-testid="live-mute-all"
      data-muted="false"
      aria-pressed="false"
      aria-label="Mute all: hold for 2 seconds"
      {...handlers}
      style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
      className="relative h-12 min-w-36 touch-none select-none overflow-hidden rounded-xl bg-white/5 px-4 text-left text-sm ring-1 ring-red-500/40 hover:bg-white/10"
    >
      {progress > 0 && (
        <span className="absolute inset-y-0 left-0 bg-red-600/70" style={{ width: `${progress * 100}%` }} aria-hidden="true" />
      )}
      <span className="relative block font-semibold text-red-200">Mute all</span>
      <span className="relative block text-[11px] text-gray-400">{progress > 0 ? `Muting in ${secondsLeft}…` : 'Hold 2 s'}</span>
    </button>
  );
}

function GroupChip({ group, count, muted }: { group: OutputGroup; count: number; muted: boolean }) {
  return (
    <button
      type="button"
      data-testid="live-group"
      data-group={group.id}
      data-muted={muted}
      aria-pressed={muted}
      onClick={() => toggleLiveGroup(group.id)}
      className={cx(
        'h-12 min-w-24 select-none rounded-xl px-3 text-left text-sm ring-1 transition-colors',
        muted ? 'bg-amber-500/90 text-black ring-amber-300' : 'bg-white/5 text-gray-100 ring-white/10 hover:bg-white/10',
      )}
    >
      <span className="block font-semibold">{group.name}</span>
      <span className={cx('block text-[11px]', muted ? 'text-black/70' : 'text-gray-500')}>
        {muted ? 'Muted' : count ? `${count} track${count === 1 ? '' : 's'}` : 'App click'}
      </span>
    </button>
  );
}

function TrackChip({ stem, reason, groupName }: { stem: Stem; reason: ReturnType<typeof liveMuteReason>; groupName: string }) {
  const own = reason === 'track';
  const silent = reason !== null;
  const note = own ? 'Muted · tap to unmute' : reason === 'group' ? `${groupName} muted` : reason === 'all' ? 'All muted' : 'Tap to mute';
  return (
    <button
      type="button"
      data-testid="live-track"
      data-name={stem.name}
      data-muted={silent}
      aria-pressed={own}
      aria-label={`${stem.name}: ${note}`}
      onClick={() => toggleLiveTrack(stem.id)}
      className={cx(
        'h-12 min-w-28 select-none rounded-xl px-3 text-left text-sm ring-1 transition-colors',
        own
          ? 'bg-amber-500/90 text-black ring-amber-300'
          : silent
            ? 'bg-amber-500/20 text-amber-100 ring-amber-500/40'
            : 'bg-white/5 text-gray-100 ring-white/10 hover:bg-white/10',
      )}
    >
      <span className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: stem.color }} />
        <span className="truncate font-medium">{stem.name}</span>
      </span>
      <span className={cx('block text-[11px]', own ? 'text-black/70' : silent ? 'text-amber-200/80' : 'text-gray-500')}>{note}</span>
    </button>
  );
}

/** Live mutes: everything plays when Live starts; tap tracks or groups to mute, hold "Mute all" for silence. */
export function LiveTracks({ stems }: { stems: Stem[] }) {
  const outputs = useApp((s) => s.outputs);
  const clickOn = useApp((s) => s.click);
  const tracks = useApp((s) => s.liveMuted);
  const groups = useApp((s) => s.liveMutedGroups);
  const all = useApp((s) => s.liveMuteAll);
  const live = liveMutes({ liveMuted: tracks, liveMutedGroups: groups, liveMuteAll: all });

  const groupOf = (s: Stem) => groupForStem(outputs, s);
  const members = new Map<string, number>();
  for (const s of stems) members.set(groupOf(s).id, (members.get(groupOf(s).id) ?? 0) + 1);
  const shown = outputs.groups.filter((g) => members.has(g.id) || (g.click && clickOn));

  return (
    <section
      className={cx('mt-4 rounded-2xl p-3 transition-colors', all ? 'bg-red-950/40 ring-2 ring-red-500' : 'bg-transparent')}
      aria-label="Tracks"
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Mutes</h3>
          <p className="text-xs text-gray-500">
            {all ? (
              <span className="font-medium text-red-200" role="status">
                Everything is muted. The song keeps playing silently.
              </span>
            ) : (
              'Everything plays in Live. Tap a group or track to mute it. Hold Mute all for 2 seconds to silence everything.'
            )}
          </p>
        </div>
        <div className="ml-auto">
          <MuteAllButton on={all} />
        </div>
      </div>
      {shown.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Groups</h4>
          <div className="flex flex-wrap gap-2">
            {shown.map((g) => (
              <GroupChip key={g.id} group={g} count={members.get(g.id) ?? 0} muted={groups.includes(g.id)} />
            ))}
          </div>
        </div>
      )}
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Tracks</h4>
      <div className="flex flex-wrap gap-2">
        {stems.map((s) => (
          <TrackChip key={s.id} stem={s} reason={liveMuteReason(s, live, (x) => groupOf(x).id)} groupName={groupOf(s).name} />
        ))}
      </div>
    </section>
  );
}
