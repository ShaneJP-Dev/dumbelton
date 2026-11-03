import { useEffect, useState } from 'react';
import { barLength } from '../audio/core/grid';
import { SAMPLE_RATE } from '../audio/core/types';
import { analyzeProject } from '../lib/analysis';
import {
  defaultSections,
  KIND_META,
  KINDS,
  mergeWithNext,
  removeSection,
  renameSection,
  setKind,
  snapFrame,
  splitAt,
  type SnapMode,
} from '../lib/sections';
import type { Project } from '../lib/types';
import { patchProject, syncProgram } from '../state/actions';
import { peekEngine } from '../state/engine';
import { setState, useApp } from '../state/store';
import { Scissors, Trash, Wand } from './icons';
import { Button, cx, Spinner } from './ui';

function SnapPicker() {
  const snap = useApp((s) => s.snap);
  const opts: [SnapMode, string][] = [
    ['bar', 'Bar'],
    ['beat', 'Beat'],
    ['off', 'Free'],
  ];
  return (
    <div className="flex items-center gap-1 rounded-lg bg-white/5 p-1" role="group" aria-label="Snap edges to">
      <span className="px-1.5 text-xs text-gray-400">Snap</span>
      {opts.map(([v, l]) => (
        <button
          key={v}
          type="button"
          aria-pressed={snap === v}
          onClick={() => setState({ snap: v })}
          className={cx('h-8 rounded-md px-2.5 text-xs font-medium', snap === v ? 'bg-white/20 text-white' : 'text-gray-400 hover:text-white')}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function SectionEditor({ project }: { project: Project }) {
  const selected = useApp((s) => s.selected);
  const snap = useApp((s) => s.snap);
  const idx = project.sections.findIndex((s) => s.id === selected);
  const sec = idx >= 0 ? project.sections[idx] : null;
  const [name, setName] = useState(sec?.name ?? '');
  useEffect(() => setName(sec?.name ?? ''), [sec?.id, sec?.name]);

  const minLen = Math.max(SAMPLE_RATE / 2, project.downbeats.length >= 2 ? barLength(project.downbeats) : SAMPLE_RATE);
  const analysis = project.analysis;
  const running = analysis.status === 'running';

  const edit = (fn: (p: Project) => Project) => {
    patchProject(fn);
    syncProgram();
  };

  const reanalyse = () => {
    if (project.sections.length > 0 && !window.confirm('Find sections again? Your section edits and arrangements will be replaced.')) return;
    void analyzeProject(project);
  };

  if (project.sections.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2 py-2">
        {running ? (
          <span className="flex items-center gap-2 text-sm text-gray-300">
            <Spinner /> Finding chorus, verses and bridge… {Math.round((analysis.progress ?? 0) * 100)}%
          </span>
        ) : (
          <>
            <Button variant="primary" onClick={() => void analyzeProject(project)}>
              <Wand size={16} /> Find sections automatically
            </Button>
            <Button onClick={() => edit((p) => ({ ...p, sections: defaultSections(p.lengthFrames) }))}>Mark sections by hand</Button>
            {analysis.status === 'error' && <span className="text-sm text-red-300">{analysis.error}</span>}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      {sec ? (
        <>
          <input
            value={name}
            aria-label="Section name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== sec.name && edit((p) => ({ ...p, sections: renameSection(p.sections, idx, name) }))}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="h-10 w-36 rounded-lg bg-white/10 px-3 text-sm outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="flex flex-wrap gap-1" role="group" aria-label="Section type">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={sec.kind === k}
                onClick={() => edit((p) => ({ ...p, sections: setKind(p.sections, idx, k) }))}
                className={cx(
                  'h-8 rounded-md px-2 text-xs font-medium ring-1 ring-inset',
                  sec.kind === k ? 'text-white ring-white/60' : 'text-gray-300 ring-white/10 hover:ring-white/30',
                )}
                style={sec.kind === k ? { background: KIND_META[k].color } : undefined}
              >
                {KIND_META[k].label}
              </button>
            ))}
          </div>
          <Button
            title="Split this section at the playhead"
            onClick={() => {
              const f = peekEngine()?.clock.now() ?? sec.start;
              const at = snapFrame(f, snap, project.beats, project.downbeats);
              edit((p) => ({ ...p, sections: splitAt(p.sections, at, minLen) }));
            }}
          >
            <Scissors size={16} /> Split at playhead
          </Button>
          <Button disabled={idx >= project.sections.length - 1} onClick={() => edit((p) => ({ ...p, sections: mergeWithNext(p.sections, idx) }))}>
            Merge with next
          </Button>
          <Button
            variant="ghost"
            aria-label="Delete section"
            disabled={project.sections.length <= 1}
            onClick={() => {
              edit((p) => ({ ...p, sections: removeSection(p.sections, idx) }));
              setState({ selected: null });
            }}
          >
            <Trash size={16} />
          </Button>
        </>
      ) : (
        <span className="text-sm text-gray-400">Tap a section to jump to it. Drag the edges between sections to adjust them.</span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <SnapPicker />
        <Button variant="ghost" onClick={reanalyse} disabled={running} title="Find sections again">
          {running ? <Spinner /> : <Wand size={16} />} {running ? `${Math.round((analysis.progress ?? 0) * 100)}%` : 'Re-analyse'}
        </Button>
      </div>
    </div>
  );
}
