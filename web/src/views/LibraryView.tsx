import { useState } from 'react';
import { SAMPLE_RATE } from '../audio/core/types';
import { DropZone, ImportDialog } from '../components/ImportDialog';
import { filesFromDrop } from '../lib/audioFiles';
import { ListIcon, Plus, Trash } from '../components/icons';
import { Button, formatTime } from '../components/ui';
import { KIND_META } from '../lib/sections';
import type { Project } from '../lib/types';
import { deleteProject, navigate } from '../state/actions';
import { useApp } from '../state/store';

function SectionStrip({ p }: { p: Project }) {
  if (p.sections.length === 0) return <div className="h-2 rounded bg-white/10" />;
  return (
    <div className="flex h-2 overflow-hidden rounded">
      {p.sections.map((s) => (
        <div key={s.id} style={{ flex: s.end - s.start, background: KIND_META[s.kind].color }} className="border-r border-black/40" />
      ))}
    </div>
  );
}

function SongCard({ p }: { p: Project }) {
  const status =
    p.analysis.status === 'running'
      ? 'Finding sections…'
      : p.analysis.status === 'error'
        ? 'Sections not found'
        : `${p.sections.length} sections`;
  return (
    <div className="group relative rounded-2xl bg-white/5 p-4 ring-1 ring-white/5 hover:bg-white/[0.07]">
      <button type="button" className="block w-full text-left" onClick={() => navigate({ name: 'song', id: p.id })} data-testid="song-card">
        <div className="truncate text-lg font-semibold">{p.name}</div>
        <div className="mb-3 text-sm text-gray-400">
          {formatTime(p.lengthFrames / SAMPLE_RATE)} · {p.stems.length} tracks
          {p.bpm ? ` · ${Math.round(p.bpm)} BPM` : ''} · {status}
        </div>
        <SectionStrip p={p} />
      </button>
      <button
        type="button"
        aria-label={`Delete ${p.name}`}
        onClick={() => window.confirm(`Delete "${p.name}" and its tracks from this device?`) && void deleteProject(p.id)}
        className="absolute top-3 right-3 rounded-md p-2 text-gray-500 opacity-0 hover:bg-white/10 hover:text-red-300 focus:opacity-100 group-hover:opacity-100"
      >
        <Trash size={16} />
      </button>
    </div>
  );
}

export function LibraryView() {
  const projects = useApp((s) => s.projects);
  const [importOpen, setImportOpen] = useState(false);
  const [dropped, setDropped] = useState<{ files: File[]; folder: string | null }>({ files: [], folder: null });

  const startImport = (files: File[], folder: string | null = null) => {
    setDropped({ files, folder });
    setImportOpen(true);
  };

  return (
    <div
      className="mx-auto max-w-5xl px-4 py-6 md:py-10"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void filesFromDrop(e.dataTransfer).then(({ files, folder }) => files.length && startImport(files, folder));
      }}
    >
      <header className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Songs</h1>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={() => navigate({ name: 'setlists' })}>
            <ListIcon size={16} /> Setlists
          </Button>
          <Button variant="primary" onClick={() => startImport([])} data-testid="new-song">
            <Plus size={16} /> New song
          </Button>
        </div>
      </header>
      {projects.length === 0 ? (
        <div className="mt-10">
          <p className="mb-6 text-center text-gray-400">
            Upload the stems of a song (drums, bass, keys, vocals…). You will see its intro, verses, choruses and bridge
            straight away, and can loop, slow down, rearrange and play it live.
          </p>
          <DropZone onFiles={startImport} />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <SongCard key={p.id} p={p} />
          ))}
        </div>
      )}
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        initialFiles={dropped.files}
        initialFolder={dropped.folder}
      />
    </div>
  );
}
