import { useEffect, useState } from 'react';
import { SAMPLE_RATE } from '../audio/core/types';
import { lowerBound } from '../audio/core/grid';
import { releaseWakeLock, requestWakeLock } from '../audio/engine/session';
import { usePlayheadValue } from '../hooks/usePlayhead';
import { livePads } from '../lib/arrangement';
import { barsIn, KIND_META } from '../lib/sections';
import type { Project } from '../lib/types';
import { getEngine, peekEngine } from '../state/engine';
import { navigate } from '../state/actions';
import { goToSetlistIndex, goToSongLive, nextSong, saveLiveState } from '../state/live';
import { setState, useApp } from '../state/store';
import { Expand, Next, Prev, X } from './icons';
import { Button, cx, formatTime } from './ui';

/** Bars (downbeats) from frame f until the queued jump lands. */
function barsUntil(downbeats: number[], f: number, at: number): number {
  if (downbeats.length === 0) return 0;
  return Math.max(0, lowerBound(downbeats, at) - lowerBound(downbeats, f + 1));
}

interface SongRow {
  key: string;
  index: number;
  project: Project | undefined;
  projectId: string;
  arrangement?: string;
}

/**
 * Every setlist (or all songs) on the Live screen. Tap a song to go to it.
 * `sidebar` is the tall list for wide screens, `strip` the compact one for narrow screens.
 */
function LiveSongList({ variant }: { variant: 'sidebar' | 'strip' }) {
  const live = useApp((s) => s.live);
  const setlists = useApp((s) => s.setlists);
  const projects = useApp((s) => s.projects);
  const current = useApp((s) => s.current);
  const ended = useApp((s) => s.liveEnded);
  const [view, setView] = useState<string>(live?.setlistId ?? 'all');
  useEffect(() => {
    if (live) setView(live.setlistId);
  }, [live?.setlistId]);

  const setlist = view === 'all' ? undefined : setlists.find((x) => x.id === view);
  const byId = (id: string) => projects.find((p) => p.id === id);
  const rows: SongRow[] = setlist
    ? setlist.entries.map((e, i) => {
        const p = byId(e.projectId);
        return { key: e.id, index: i, project: p, projectId: e.projectId, arrangement: p?.arrangements.find((a) => a.id === e.arrangementId)?.name };
      })
    : [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p, i) => ({ key: p.id, index: i, project: p, projectId: p.id }));

  const playingHere = setlist && live?.setlistId === setlist.id;
  const isCurrent = (r: SongRow) => (setlist ? !!playingHere && live!.index === r.index : !live && current?.id === r.projectId);
  const isNext = (r: SongRow) => !!playingHere && live!.index + 1 === r.index;
  const go = (r: SongRow) => {
    if (isCurrent(r)) return;
    if (setlist) void goToSetlistIndex(setlist.id, r.index);
    else void goToSongLive(r.projectId);
  };
  const next = live && playingHere ? setlist!.entries[live.index + 1] : undefined;

  const picker = (
    <select
      value={view}
      onChange={(e) => setView(e.target.value)}
      aria-label="Song list"
      data-testid="song-list-picker"
      className="h-9 min-w-0 max-w-full rounded-lg bg-white/10 px-2 text-sm font-medium"
    >
      <option value="all" className="bg-[#151924]">
        All songs ({projects.length})
      </option>
      {setlists.map((sl) => (
        <option key={sl.id} value={sl.id} className="bg-[#151924]">
          {sl.name} ({sl.entries.length})
        </option>
      ))}
    </select>
  );
  const nextButton = playingHere && (
    <div className="flex gap-1">
      <Button variant="ghost" aria-label="Previous song" disabled={live!.index === 0} onClick={() => nextSong(-1)}>
        <Prev size={16} />
      </Button>
      <Button
        variant={ended && next ? 'primary' : 'subtle'}
        disabled={!next}
        onClick={() => nextSong(1)}
        className={cx('min-w-0', ended && next && 'animate-pulse')}
        data-testid="next-song"
      >
        <span className="truncate">{next ? <>Next: {byId(next.projectId)?.name ?? 'Missing song'}</> : 'Last song'}</span> <Next size={16} />
      </Button>
    </div>
  );

  if (variant === 'strip') {
    return (
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-white/5 p-2" data-testid="live-song-strip">
        {picker}
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {rows.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => go(r)}
              className={cx(
                'h-9 shrink-0 rounded-lg px-3 text-sm',
                isCurrent(r) ? 'bg-white font-semibold text-black' : isNext(r) ? 'text-white ring-1 ring-white/40' : 'text-gray-300 hover:bg-white/10',
              )}
            >
              {setlist ? `${r.index + 1}. ` : ''}
              {r.project?.name ?? 'Missing song'}
            </button>
          ))}
        </div>
        {nextButton}
      </div>
    );
  }

  return (
    <aside className="flex max-h-[calc(100vh-220px)] flex-col rounded-2xl bg-white/5 p-2" data-testid="live-song-list">
      <div className="mb-2 flex flex-col gap-2">
        {picker}
        {nextButton}
      </div>
      <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {rows.length === 0 && (
          <li className="px-2 py-3 text-sm text-gray-500">{setlist ? 'This setlist is empty.' : 'No songs yet.'}</li>
        )}
        {rows.map((r) => {
          const p = r.project;
          return (
            <li key={r.key}>
              <button
                type="button"
                data-testid="live-song"
                data-name={p?.name}
                onClick={() => go(r)}
                disabled={!p}
                className={cx(
                  'flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left',
                  isCurrent(r) ? 'bg-white text-black' : 'hover:bg-white/10',
                  isNext(r) && 'ring-1 ring-white/40',
                )}
              >
                {setlist && <span className={cx('w-5 text-right text-xs tabular-nums', isCurrent(r) ? 'text-black/60' : 'text-gray-500')}>{r.index + 1}</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{p?.name ?? 'Missing song'}</span>
                  <span className={cx('block truncate text-xs', isCurrent(r) ? 'text-black/60' : 'text-gray-500')}>
                    {p ? formatTime(p.lengthFrames / SAMPLE_RATE) : ''}
                    {p?.bpm ? ` · ${Math.round(p.bpm)} BPM` : ''}
                    {r.arrangement ? ` · ${r.arrangement}` : ''}
                  </span>
                </span>
                {isCurrent(r) && <span className="text-[11px] font-semibold uppercase">Now</span>}
                {isNext(r) && <span className="text-[11px] font-semibold uppercase text-gray-300">Next</span>}
              </button>
            </li>
          );
        })}
      </ol>
      <button type="button" onClick={() => navigate({ name: 'setlists' })} className="mt-2 h-9 rounded-lg text-sm text-gray-400 hover:bg-white/10 hover:text-white">
        Edit setlists
      </button>
    </aside>
  );
}

export function LivePanel({ project }: { project: Project }) {
  const transport = useApp((s) => s.transport);
  const quantize = useApp((s) => s.quantize);
  const arrangementId = useApp((s) => s.liveArrangementId);
  const pads = livePads(project, arrangementId);
  const pending = transport.pending;
  const countdown = usePlayheadValue((f) => (pending ? barsUntil(project.downbeats, f, pending.at) : -1), -1);
  const arrangement = arrangementId ? project.arrangements.find((a) => a.id === arrangementId) : undefined;

  useEffect(() => {
    void requestWakeLock();
    const onVis = () => document.visibilityState === 'visible' && void requestWakeLock();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void releaseWakeLock();
    };
  }, []);

  useEffect(() => {
    saveLiveState(transport.segment);
  }, [transport.segment]);

  const tap = (i: number) => {
    const playing = peekEngine()?.clock.playing ?? false;
    void getEngine().then((e) => e.queueJump(i, playing ? quantize : 'now'));
  };

  const noSections = project.sections.length === 0;

  return (
    <div className="gap-4 py-3 lg:flex" data-testid="live-panel">
      <div className="min-w-0 flex-1">
      <div className="lg:hidden">
        <LiveSongList variant="strip" />
      </div>
      {noSections ? (
        <p className="py-6 text-center text-gray-400">Find or mark this song's sections first (Practice tab).</p>
      ) : (
      <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-white/5 p-1" role="group" aria-label="When a tapped section starts">
          {(
            [
              ['segmentEnd', 'At end of section'],
              ['nextBar', 'At next bar'],
            ] as const
          ).map(([q, label]) => (
            <button
              key={q}
              type="button"
              aria-pressed={quantize === q}
              onClick={() => setState({ quantize: q })}
              className={cx('h-9 rounded-md px-3 text-sm', quantize === q ? 'bg-white/20 font-medium text-white' : 'text-gray-400 hover:text-white')}
            >
              {label}
            </button>
          ))}
        </div>
        {arrangement && <span className="text-sm text-gray-400">Arrangement: {arrangement.name}</span>}
        <div className="ml-auto flex gap-2">
          {pending && (
            <Button onClick={() => void getEngine().then((e) => e.cancelJump())}>
              <X size={16} /> Cancel next
            </Button>
          )}
          {document.fullscreenEnabled && (
            <Button
              variant="ghost"
              aria-label="Full screen"
              onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen())}
            >
              <Expand size={18} />
            </Button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {pads.map(({ key, section }, i) => {
          const isCurrent = i === transport.segment;
          const isNext = pending?.to === i;
          const bars = barsIn(section, project.downbeats);
          return (
            <button
              key={key}
              type="button"
              data-testid="pad"
              data-name={section.name}
              onClick={() => tap(i)}
              className={cx(
                'relative flex h-28 flex-col justify-between rounded-2xl p-3 text-left text-white shadow-lg transition md:h-32',
                isCurrent ? 'brightness-110 ring-4 ring-white' : 'brightness-75 hover:brightness-95',
                isNext && 'animate-pulse ring-4 ring-amber-300',
              )}
              style={{ background: KIND_META[section.kind].color }}
            >
              <span className="flex items-start justify-between gap-2">
                <span className="text-lg font-bold leading-tight md:text-xl">{section.name}</span>
                {i < 9 && <span className="rounded bg-black/25 px-1.5 text-xs font-semibold">{i + 1}</span>}
              </span>
              <span className="text-sm text-white/85">
                {isCurrent && transport.playing ? 'Playing' : isNext ? (countdown > 0 ? `Next · in ${countdown} bar${countdown === 1 ? '' : 's'}` : 'Next') : bars ? `${bars} bars` : ''}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-4 text-center text-xs text-gray-500">
        Tap a section to play it next. Keys: Space play/stop · 1–9 sections · ← → previous/next section (works with page-turner pedals) ·
        Shift+→ next song
      </p>
      </>
      )}
      </div>
      <div className="hidden w-72 shrink-0 lg:block">
        <LiveSongList variant="sidebar" />
      </div>
    </div>
  );
}
