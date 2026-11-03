import { lowerBound } from '../audio/core/grid';
import { SAMPLE_RATE } from '../audio/core/types';
import { usePlayheadValue } from '../hooks/usePlayhead';
import type { Project } from '../lib/types';
import { setClick, setSpeed, syncProgram, togglePlay } from '../state/actions';
import { setState, useApp } from '../state/store';
import { Loop, Metronome, Pause, Play } from './icons';
import { cx, formatTime, Toggle } from './ui';

export const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1];

function barBeat(project: Project, f: number): string {
  const { downbeats, beats } = project;
  if (downbeats.length === 0) return '';
  const bar = lowerBound(downbeats, f + 1); // downbeats <= f
  if (bar === 0) return 'Bar 0';
  const beatInBar = lowerBound(beats, f + 1) - lowerBound(beats, downbeats[bar - 1]);
  return `Bar ${bar}.${Math.max(1, beatInBar)}`;
}

function Position({ project }: { project: Project }) {
  const text = usePlayheadValue((f) => {
    const t = formatTime(f / SAMPLE_RATE);
    const bb = barBeat(project, f);
    return bb ? `${bb} · ${t}` : t;
  }, '0:00');
  return (
    <div className="min-w-0 tabular-nums" data-testid="position">
      <div className="truncate text-sm font-medium">{text}</div>
      <div className="text-xs text-gray-500">{formatTime(project.lengthFrames / SAMPLE_RATE)}</div>
    </div>
  );
}

export function Transport({ project }: { project: Project }) {
  const playing = useApp((s) => s.transport.playing);
  const mode = useApp((s) => s.mode);
  const speed = useApp((s) => s.speed);
  const click = useApp((s) => s.click);
  const countIn = useApp((s) => s.countIn);
  const loop = useApp((s) => s.loop);
  const selected = useApp((s) => s.selected);
  const bpm = project.bpm ? Math.round(project.bpm * speed) : null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-white/10 bg-[#0f1219] px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:gap-3 md:px-4">
      <button
        type="button"
        onClick={() => void togglePlay()}
        aria-label={playing ? 'Pause' : 'Play'}
        data-testid="play"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-black hover:bg-gray-200"
      >
        {playing ? <Pause size={22} /> : <Play size={22} />}
      </button>
      <Position project={project} />
      <div className="mx-1 hidden h-8 w-px bg-white/10 sm:block" />
      {bpm !== null && (
        <div className="text-sm tabular-nums text-gray-300" title="Tempo at the current speed">
          {bpm} <span className="text-gray-500">BPM</span>
        </div>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {mode === 'practice' && (
          <Toggle
            on={loop}
            onClick={() => {
              setState({ loop: !loop });
              syncProgram();
            }}
            title={selected ? 'Loop the selected section' : 'Select a section to loop'}
          >
            <Loop size={16} /> <span className="hidden sm:inline">Loop</span>
          </Toggle>
        )}
        <Toggle on={click} onClick={() => setClick(!click)} title="Click track from the beat grid">
          <Metronome size={16} /> <span className="hidden sm:inline">Click</span>
        </Toggle>
        <Toggle on={countIn} onClick={() => setState({ countIn: !countIn })} title="One bar of clicks before playing">
          <span className="text-xs font-semibold">1-bar</span> <span className="hidden sm:inline">count-in</span>
        </Toggle>
        <label className="flex items-center gap-1.5 rounded-lg bg-white/10 px-2 text-sm">
          <span className="text-gray-400">Speed</span>
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            aria-label="Playback speed"
            className={cx('h-10 bg-transparent font-medium outline-none', speed !== 1 && 'text-amber-300')}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s} className="bg-[#151924]">
                {Math.round(s * 100)}%
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
