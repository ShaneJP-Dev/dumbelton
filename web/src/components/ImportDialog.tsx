import { useEffect, useRef, useState } from 'react';
import { analyzeProject } from '../lib/analysis';
import { ACCEPTED_AUDIO, addStems, importSong, type ImportProgress } from '../lib/importer';
import { songNameFromFiles, stemNamesFromFiles } from '../lib/stemNames';
import type { Project } from '../lib/types';
import { navigate, patchProject, refreshLibrary, toast } from '../state/actions';
import { Upload } from './icons';
import { Button, Modal, Spinner } from './ui';

export function isAudioFile(f: File): boolean {
  return f.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|flac|ogg|aiff?)$/i.test(f.name);
}

export function DropZone({ onFiles, compact }: { onFiles: (f: File[]) => void; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles(Array.from(e.dataTransfer.files).filter(isAudioFile));
      }}
      onClick={() => input.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed text-center transition-colors ${
        over ? 'border-blue-400 bg-blue-500/10' : 'border-white/15 hover:border-white/30'
      } ${compact ? 'p-5' : 'p-10'}`}
    >
      <Upload size={compact ? 22 : 32} className="mb-2 text-gray-400" />
      <div className="font-medium">Drop your stems here</div>
      <div className="mt-1 text-sm text-gray-400">or tap to choose files (WAV, MP3, M4A, FLAC)</div>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPTED_AUDIO}
        data-testid="file-input"
        className="hidden"
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </div>
  );
}

function progressText(p: ImportProgress | null): string {
  if (!p) return '';
  if (p.stage === 'done') return 'Saving…';
  return `${p.stage === 'decoding' ? 'Reading' : 'Converting'} ${p.file} (${p.index + 1} of ${p.total})`;
}

/** New song from stems, or (with `addTo`) more stems for an existing song. */
export function ImportDialog({
  open,
  onClose,
  initialFiles = [],
  addTo,
}: {
  open: boolean;
  onClose: () => void;
  initialFiles?: File[];
  addTo?: Project;
}) {
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  useEffect(() => {
    if (open) {
      setFiles(initialFiles);
      setName(songNameFromFiles(initialFiles.map((f) => f.name)));
      setProgress(null);
    }
  }, [open, initialFiles]);

  const addFiles = (more: File[]) => {
    const next = [...files, ...more.filter((m) => !files.some((f) => f.name === m.name && f.size === m.size))];
    setFiles(next);
    if (!name || name === 'New song') setName(songNameFromFiles(next.map((f) => f.name)));
  };

  const run = async () => {
    setBusy(true);
    try {
      if (addTo) {
        const next = await addStems(addTo, files, setProgress);
        patchProject(() => next);
        toast(`Added ${files.length} track${files.length > 1 ? 's' : ''}. Reload the song to hear them.`);
        onClose();
      } else {
        const project = await importSong(name, files, setProgress);
        await refreshLibrary();
        onClose();
        navigate({ name: 'song', id: project.id });
        void analyzeProject(project);
      }
    } catch (err) {
      toast(String((err as Error).message ?? err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const names = stemNamesFromFiles(files.map((f) => f.name));
  return (
    <Modal open={open} onClose={() => !busy && onClose()} title={addTo ? `Add tracks to ${addTo.name}` : 'New song'}>
      {!addTo && (
        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-gray-400">Song name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            data-testid="song-name"
            className="h-11 w-full rounded-lg bg-white/10 px-3 outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="e.g. Way Maker"
          />
        </label>
      )}
      {!busy && <DropZone onFiles={addFiles} compact />}
      {files.length > 0 && (
        <ul className="mt-3 max-h-48 overflow-auto rounded-lg bg-black/20 p-2 text-sm">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 px-2 py-1">
              <span className="truncate">{names[i]}</span>
              <span className="shrink-0 text-xs text-gray-500">{(f.size / 1e6).toFixed(1)} MB</span>
            </li>
          ))}
        </ul>
      )}
      {busy && (
        <div className="mt-4 flex items-center gap-2 text-sm text-gray-300">
          <Spinner /> {progressText(progress)}
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void run()} disabled={busy || files.length === 0} data-testid="import">
          {addTo ? 'Add tracks' : `Import ${files.length || ''} track${files.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </Modal>
  );
}
