import { useCallback, useEffect, useState } from 'react';
import { ArrangePanel } from '../components/ArrangePanel';
import { Back, More, Plus, Trash } from '../components/icons';
import { ImportDialog } from '../components/ImportDialog';
import { LivePanel } from '../components/LivePanel';
import { SectionEditor } from '../components/SectionEditor';
import { seekTo, Timeline } from '../components/Timeline';
import { Transport } from '../components/Transport';
import { Button, cx } from '../components/ui';
import { useShortcuts } from '../hooks/useShortcuts';
import { sectionIndexAt } from '../lib/sections';
import { deleteProject, navigate, openProject, patchProject, setClick, setMode, syncProgram, togglePlay } from '../state/actions';
import { getEngine, peekEngine } from '../state/engine';
import { getState, setState, useApp, type Mode } from '../state/store';

const MODES: [Mode, string][] = [
  ['practice', 'Practice'],
  ['arrange', 'Arrange'],
  ['live', 'Live'],
];

function SongMenu({ onAddTracks }: { onAddTracks: () => void }) {
  const [open, setOpen] = useState(false);
  const project = useApp((s) => s.current);
  if (!project) return null;
  return (
    <div className="relative">
      <Button variant="ghost" aria-label="Song menu" onClick={() => setOpen(!open)}>
        <More />
      </Button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-56 rounded-xl bg-[#1a1f2c] p-1 shadow-2xl ring-1 ring-white/10" onMouseLeave={() => setOpen(false)}>
          <button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-white/10" onClick={() => { setOpen(false); onAddTracks(); }}>
            <Plus size={16} /> Add tracks
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-red-300 hover:bg-white/10"
            onClick={() => {
              setOpen(false);
              if (window.confirm(`Delete "${project.name}"?`)) {
                navigate({ name: 'library' });
                void deleteProject(project.id);
              }
            }}
          >
            <Trash size={16} /> Delete song
          </button>
        </div>
      )}
    </div>
  );
}

export function SongView({ id }: { id: string }) {
  const project = useApp((s) => s.current);
  const mode = useApp((s) => s.mode);
  const engineError = useApp((s) => s.engineError);
  const [addOpen, setAddOpen] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let alive = true;
    void openProject(id).then((p) => alive && setNotFound(!p));
    return () => {
      alive = false;
      if (!getState().live) peekEngine()?.pause();
    };
  }, [id]);

  const jumpToSection = useCallback((i: number) => {
    const { current, mode: m, quantize } = getState();
    if (!current || i < 0 || i >= current.sections.length) return;
    if (m === 'live') {
      void getEngine().then((e) => e.queueJump(i, peekEngine()?.clock.playing ? quantize : 'now'));
      return;
    }
    setState({ selected: current.sections[i].id });
    if (getState().loop) syncProgram();
    seekTo(current.sections[i].start);
  }, []);

  const currentIndex = () => {
    const { current, mode: m, transport } = getState();
    if (!current) return 0;
    if (m === 'live') return transport.pending?.to ?? transport.segment;
    return sectionIndexAt(current.sections, peekEngine()?.clock.now() ?? 0);
  };

  useShortcuts(
    useCallback(
      (e: KeyboardEvent) => {
        const { current } = getState();
        if (!current) return;
        if (e.key === ' ') {
          void togglePlay();
          return true;
        }
        if (e.shiftKey) return; // Shift+arrows are for setlists (Live)
        if (e.key === 'ArrowRight' || e.key === 'PageDown') {
          jumpToSection(currentIndex() + 1);
          return true;
        }
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
          jumpToSection(Math.max(0, currentIndex() - 1));
          return true;
        }
        if (/^[1-9]$/.test(e.key)) {
          jumpToSection(Number(e.key) - 1);
          return true;
        }
        if (e.key === 'l' || e.key === 'L') {
          setState({ loop: !getState().loop });
          syncProgram();
          return true;
        }
        if (e.key === 'c' || e.key === 'C') {
          setClick(!getState().click);
          return true;
        }
        if (e.key === 'Escape') setState({ selected: null });
      },
      [jumpToSection],
    ),
  );

  if (notFound) {
    return (
      <div className="p-8 text-center">
        <p className="mb-4 text-gray-400">This song is not on this device.</p>
        <Button onClick={() => navigate({ name: 'library' })}>Back to songs</Button>
      </div>
    );
  }
  if (!project || project.id !== id) return <div className="p-8 text-gray-400">Loading…</div>;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-white/10 px-2 py-2 md:px-4">
        <Button variant="ghost" aria-label="Back to songs" onClick={() => navigate({ name: 'library' })}>
          <Back />
        </Button>
        <input
          value={project.name}
          aria-label="Song name"
          onChange={(e) => patchProject((p) => ({ ...p, name: e.target.value }))}
          className="h-10 min-w-0 flex-1 truncate rounded-lg bg-transparent px-2 text-lg font-semibold outline-none hover:bg-white/5 focus:bg-white/10 md:max-w-sm"
        />
        <nav className="ml-auto flex rounded-xl bg-white/5 p-1" aria-label="Mode">
          {MODES.map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cx('h-9 rounded-lg px-3 text-sm font-medium md:px-4', mode === m ? 'bg-white text-black' : 'text-gray-300 hover:text-white')}
            >
              {label}
            </button>
          ))}
        </nav>
        <SongMenu onAddTracks={() => setAddOpen(true)} />
      </header>
      {engineError && (
        <div className="bg-red-950 px-4 py-2 text-sm text-red-200">Audio could not start: {engineError}</div>
      )}
      <main className="flex-1 overflow-auto px-2 pb-4 md:px-4">
        {mode === 'live' ? (
          <LivePanel project={project} />
        ) : (
          <>
            {mode === 'practice' && <SectionEditor project={project} />}
            {mode === 'arrange' && <ArrangePanel project={project} />}
            <Timeline project={project} />
          </>
        )}
      </main>
      <Transport project={project} />
      <ImportDialog open={addOpen} onClose={() => setAddOpen(false)} addTo={project} />
    </div>
  );
}
