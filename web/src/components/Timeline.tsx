import { useCallback, useRef, type PointerEvent as RPointerEvent } from 'react';
import { barLength } from '../audio/core/grid';
import { SAMPLE_RATE } from '../audio/core/types';
import { usePlayhead, usePlayheadValue, useWidth } from '../hooks/usePlayhead';
import { KIND_META, moveBoundary, sectionIndexAt, snapFrame, barsIn, shortName } from '../lib/sections';
import type { Project, Stem } from '../lib/types';
import { patchProject, syncProgram, syncStems } from '../state/actions';
import { getEngine } from '../state/engine';
import { getState, setState, useApp } from '../state/store';
import { cx } from './ui';
import { VolumeFader } from './VolumeFader';
import { Waveform } from './Waveform';

const SECTION_H = 56;

const LANE_H = 64;

export function seekTo(frame: number): void {
  const { current, loop, selected } = getState();
  if (!current) return;
  const i = sectionIndexAt(current.sections, frame);
  const sec = i >= 0 ? current.sections[i] : null;
  if (sec && (sec.id !== selected || !loop)) {
    setState({ selected: sec.id });
    if (loop) syncProgram();
  }
  void getEngine().then((e) => e.seek(frame));
}

function SectionBar({ project, width }: { project: Project; width: number }) {
  const selected = useApp((s) => s.selected);
  const snapMode = useApp((s) => s.snap);
  const analysis = project.analysis;
  const len = project.lengthFrames;
  const current = usePlayheadValue((f) => sectionIndexAt(project.sections, f), -1);
  const drag = useRef<{ i: number; rect: DOMRect } | null>(null);

  const minLen = Math.max(SAMPLE_RATE / 2, project.downbeats.length >= 2 ? barLength(project.downbeats) : SAMPLE_RATE);

  const onHandleDown = (i: number) => (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const parent = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    drag.current = { i, rect: parent };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const x = Math.max(0, Math.min(d.rect.width, e.clientX - d.rect.left));
    const raw = (x / d.rect.width) * len;
    const f = snapFrame(raw, snapMode, project.beats, project.downbeats);
    patchProject((p) => ({ ...p, sections: moveBoundary(p.sections, d.i, f, minLen) }));
  };
  const onHandleUp = () => {
    if (drag.current) {
      drag.current = null;
      syncProgram();
    }
  };

  if (project.sections.length === 0) {
    return (
      <div className="flex h-full items-center rounded-lg bg-white/5 px-3 text-sm text-gray-400">
        {analysis.status === 'running'
          ? `Finding sections… ${Math.round((analysis.progress ?? 0) * 100)}%`
          : analysis.status === 'error'
            ? 'Could not find sections automatically.'
            : 'No sections yet.'}
      </div>
    );
  }

  return (
    <div className="relative h-full" data-testid="section-bar">
      {project.sections.map((s, i) => {
        const left = (s.start / len) * width;
        const w = ((s.end - s.start) / len) * width;
        const bars = barsIn(s, project.downbeats);
        return (
          <button
            key={s.id}
            type="button"
            data-testid="section"
            data-name={s.name}
            onClick={() => {
              setState({ selected: s.id });
              if (getState().loop) syncProgram();
              seekTo(s.start);
            }}
            className={cx(
              'absolute top-0 bottom-0 overflow-hidden rounded-md px-2 text-left transition-[filter,box-shadow]',
              i === current ? 'brightness-125' : 'brightness-90 hover:brightness-110',
              selected === s.id && 'ring-2 ring-white z-10',
            )}
            style={{ left: left + 1, width: Math.max(2, w - 2), background: KIND_META[s.kind].color }}
            title={`${s.name}${bars ? ` · ${bars} bars` : ''}`}
          >
            <div className="truncate text-[13px] font-semibold leading-tight text-white drop-shadow">{w < 64 ? shortName(s.name) : s.name}</div>
            {w > 60 && bars > 0 && <div className="text-[11px] text-white/80">{bars} bars</div>}
          </button>
        );
      })}
      {project.sections.slice(1).map((s, k) => (
        <div
          key={`h-${s.id}`}
          role="separator"
          aria-label={`Boundary before ${s.name}`}
          onPointerDown={onHandleDown(k + 1)}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          className="group absolute top-0 bottom-0 z-20 -ml-2 w-4 cursor-col-resize touch-none"
          style={{ left: (s.start / len) * width }}
        >
          <div className="mx-auto h-full w-1 rounded bg-white/0 group-hover:bg-white/80" />
        </div>
      ))}
    </div>
  );
}

function TrackHeader({ stem, index }: { stem: Stem; index: number }) {
  const anySolo = useApp((s) => s.current?.stems.some((x) => x.solo) ?? false);
  const update = (patch: Partial<Stem>) => {
    patchProject((p) => ({ ...p, stems: p.stems.map((s, j) => (j === index ? { ...s, ...patch } : s)) }));
    syncStems();
  };
  const audible = !stem.muted && (!anySolo || stem.solo);
  const btn = 'h-7 w-7 shrink-0 rounded-md text-xs font-bold';
  return (
    <div className="flex h-full items-center gap-2 border-b border-white/5 pr-2" data-testid="track-header">
      <div className="h-full w-1.5 shrink-0 rounded-r" style={{ background: stem.color, opacity: audible ? 1 : 0.3 }} />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <div className="flex items-center gap-1.5">
          <div className={cx('min-w-0 flex-1 truncate text-sm font-medium', !audible && 'text-gray-500')} title={stem.name}>
            {stem.name}
          </div>
          <button
            type="button"
            aria-pressed={stem.muted}
            aria-label={`Mute ${stem.name}`}
            onClick={() => update({ muted: !stem.muted })}
            className={cx(btn, stem.muted ? 'bg-amber-500 text-black' : 'bg-white/10 text-gray-300')}
          >
            M
          </button>
          <button
            type="button"
            aria-pressed={stem.solo}
            aria-label={`Solo ${stem.name}`}
            onClick={() => update({ solo: !stem.solo })}
            className={cx(btn, stem.solo ? 'bg-green-500 text-black' : 'bg-white/10 text-gray-300')}
          >
            S
          </button>
        </div>
        <VolumeFader gain={stem.gain} label={stem.name} dim={!audible} onChange={(gain) => update({ gain })} />
      </div>
    </div>
  );
}

export function Timeline({ project, showTracks = true }: { project: Project; showTracks?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const playheadRef = useRef<HTMLDivElement>(null);
  const len = project.lengthFrames;
  const anySolo = project.stems.some((s) => s.solo);

  usePlayhead((f) => {
    const el = playheadRef.current;
    if (el && width > 0) el.style.transform = `translateX(${Math.max(0, Math.min(width, (f / len) * width))}px)`;
  });

  const onSeek = useCallback(
    (e: RPointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const f = ((e.clientX - rect.left) / rect.width) * len;
      seekTo(Math.max(0, Math.min(len - 1, f)));
    },
    [len],
  );

  return (
    <div className="flex select-none">
      <div className="w-[148px] shrink-0 md:w-[232px]">
        <div style={{ height: SECTION_H }} className="flex items-end pb-1 text-[11px] uppercase tracking-wide text-gray-500">
          Sections
        </div>
        {showTracks &&
          project.stems.map((s, i) => (
            <div key={s.id} style={{ height: LANE_H }}>
              <TrackHeader stem={s} index={i} />
            </div>
          ))}
      </div>
      <div ref={ref} className="relative min-w-0 flex-1">
        <div style={{ height: SECTION_H }} className="py-1">
          {width > 0 && <SectionBar project={project} width={width} />}
        </div>
        {showTracks && (
          <div className="relative cursor-text" onPointerDown={onSeek} data-testid="lanes">
            {/* faint section shading behind the waveforms */}
            {project.sections.map((s) => (
              <div
                key={s.id}
                className="pointer-events-none absolute top-0 bottom-0 border-l border-white/10"
                style={{
                  left: (s.start / len) * width,
                  width: ((s.end - s.start) / len) * width,
                  background: `${KIND_META[s.kind].color}14`,
                }}
              />
            ))}
            {project.stems.map((s) => (
              <div key={s.id} style={{ height: LANE_H }} className="relative border-b border-white/5">
                {width > 0 && (
                  <Waveform
                    stemId={s.id}
                    length={len}
                    color={s.color}
                    dim={s.muted || s.gain === 0 || (anySolo && !s.solo)}
                    width={width}
                    height={LANE_H}
                  />
                )}
              </div>
            ))}
          </div>
        )}
        <div
          ref={playheadRef}
          data-testid="playhead"
          className="pointer-events-none absolute top-0 bottom-0 left-0 z-30 w-0.5 -ml-px bg-white shadow-[0_0_6px_rgba(255,255,255,0.7)]"
        />
      </div>
    </div>
  );
}
