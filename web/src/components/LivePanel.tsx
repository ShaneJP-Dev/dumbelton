import { useEffect } from 'react';
import { lowerBound } from '../audio/core/grid';
import { releaseWakeLock, requestWakeLock } from '../audio/engine/session';
import { usePlayheadValue } from '../hooks/usePlayhead';
import { livePads } from '../lib/arrangement';
import { barsIn, KIND_META } from '../lib/sections';
import type { Project } from '../lib/types';
import { getEngine, peekEngine } from '../state/engine';
import { goToSetlistIndex, nextSong, saveLiveState } from '../state/live';
import { setState, useApp } from '../state/store';
import { Expand, Next, Prev, X } from './icons';
import { Button, cx } from './ui';

/** Bars (downbeats) from frame f until the queued jump lands. */
function barsUntil(downbeats: number[], f: number, at: number): number {
  if (downbeats.length === 0) return 0;
  return Math.max(0, lowerBound(downbeats, at) - lowerBound(downbeats, f + 1));
}

function SetlistStrip() {
  const live = useApp((s) => s.live);
  const setlist = useApp((s) => (s.live ? s.setlists.find((x) => x.id === s.live!.setlistId) : undefined));
  const projects = useApp((s) => s.projects);
  const ended = useApp((s) => s.liveEnded);
  if (!live || !setlist) return null;
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Missing song';
  const next = setlist.entries[live.index + 1];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-white/5 p-2">
      <span className="px-1 text-xs uppercase tracking-wide text-gray-500">{setlist.name}</span>
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {setlist.entries.map((e, i) => (
          <button
            key={e.id}
            type="button"
            onClick={() => void goToSetlistIndex(setlist.id, i)}
            className={cx(
              'h-9 shrink-0 rounded-lg px-3 text-sm',
              i === live.index ? 'bg-white font-semibold text-black' : i < live.index ? 'text-gray-500' : 'text-gray-300 hover:bg-white/10',
            )}
          >
            {i + 1}. {name(e.projectId)}
          </button>
        ))}
      </div>
      <Button variant="ghost" aria-label="Previous song" disabled={live.index === 0} onClick={() => nextSong(-1)}>
        <Prev size={16} />
      </Button>
      <Button
        variant={ended && next ? 'primary' : 'subtle'}
        disabled={!next}
        onClick={() => nextSong(1)}
        className={cx(ended && next && 'animate-pulse')}
        data-testid="next-song"
      >
        {next ? <>Next: {name(next.projectId)}</> : 'Last song'} <Next size={16} />
      </Button>
    </div>
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

  if (project.sections.length === 0) {
    return <p className="py-6 text-center text-gray-400">Find or mark this song's sections first (Practice tab).</p>;
  }

  return (
    <div className="py-3" data-testid="live-panel">
      <SetlistStrip />
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
    </div>
  );
}
