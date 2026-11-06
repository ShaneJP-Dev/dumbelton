import { useEffect, useRef, useState } from 'react';
import { projectBytes } from '../audio/live/budget';
import { createBackup, restoreBackup, type RestoreResult } from '../lib/backup';
import { saveFile, type ExportedFile } from '../lib/exporter';
import { refreshLibrary, toast } from '../state/actions';
import { useApp } from '../state/store';
import { Download, Upload } from './icons';
import { Button, Modal, Spinner } from './ui';

function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function resultText(r: RestoreResult): string {
  const parts: string[] = [];
  if (r.restored.length) parts.push(`Restored ${r.restored.length} song${r.restored.length === 1 ? '' : 's'}: ${r.restored.join(', ')}.`);
  if (r.setlists) parts.push(`Added ${r.setlists} setlist${r.setlists === 1 ? '' : 's'}.`);
  if (r.alreadyHere.length) parts.push(`${r.alreadyHere.length} already here (left as they are): ${r.alreadyHere.join(', ')}.`);
  if (r.damaged.length) parts.push(`Could not restore (incomplete in the file): ${r.damaged.join(', ')}.`);
  return parts.join(' ') || 'The backup has no songs.';
}

/**
 * Save songs to one backup file, or add songs from one. Use it to move songs
 * to another computer, browser or address, or to keep a safe copy.
 */
export function BackupDialog({ open, onClose, focus }: { open: boolean; onClose: () => void; focus?: 'restore' }) {
  const projects = useApp((s) => s.projects);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<ExportedFile | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSelected(new Set(projects.map((p) => p.id)));
      setSaved(null);
      setResult(null);
      setBusy(null);
    }
  }, [open, projects]);

  const total = projects.filter((p) => selected.has(p.id)).reduce((n, p) => n + projectBytes(p), 0);

  const backUp = async () => {
    setBusy('Saving… 0%');
    try {
      setSaved(await createBackup([...selected], (f) => setBusy(`Saving… ${Math.round(f * 100)}%`)));
    } catch (err) {
      toast(`Backup failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const restore = async (file: File) => {
    setBusy('Restoring… 0%');
    setResult(null);
    try {
      const r = await restoreBackup(file, (f) => setBusy(`Restoring… ${Math.round(f * 100)}%`));
      await refreshLibrary();
      setResult(resultText(r));
    } catch (err) {
      setResult(String((err as Error).message ?? err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Back up & restore songs">
      <p className="mb-4 text-sm text-gray-400">
        Songs are saved in this browser at this address. A backup file holds songs with their sections, arrangements,
        volumes and setlists, so you can keep a copy or move them to another computer (like the church Mac).
      </p>

      <section className="mb-5">
        <h3 className="mb-2 text-sm font-semibold">Back up</h3>
        {projects.length === 0 ? (
          <p className="text-sm text-gray-500">No songs here yet.</p>
        ) : (
          <>
            <ul className="max-h-40 overflow-auto rounded-lg bg-black/20 p-2 text-sm">
              {projects.map((p) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-white/5">
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(p.id);
                        else next.delete(p.id);
                        setSelected(next);
                      }}
                      className="h-4 w-4 accent-blue-500"
                    />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="text-xs text-gray-500">{size(projectBytes(p))}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex items-center gap-2">
              {saved ? (
                <Button variant="primary" onClick={() => void saveFile(saved)} data-testid="save-backup">
                  <Download size={16} /> Save {saved.name}
                </Button>
              ) : (
                <Button variant="primary" onClick={() => void backUp()} disabled={!!busy || selected.size === 0} data-testid="make-backup">
                  <Download size={16} /> Back up {selected.size} song{selected.size === 1 ? '' : 's'} ({size(total)})
                </Button>
              )}
            </div>
          </>
        )}
      </section>

      <section className={focus === 'restore' ? 'rounded-lg ring-1 ring-blue-500/50 p-2 -m-2' : undefined}>
        <h3 className="mb-2 text-sm font-semibold">Restore</h3>
        <p className="mb-2 text-sm text-gray-400">Adds the songs and setlists from a backup file. Songs already here are left as they are.</p>
        <Button onClick={() => fileInput.current?.click()} disabled={!!busy} data-testid="restore-backup">
          <Upload size={16} /> Choose a backup file…
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".tar,application/x-tar"
          className="hidden"
          data-testid="restore-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void restore(f);
          }}
        />
      </section>

      {busy && (
        <p className="mt-4 flex items-center gap-2 text-sm text-gray-300">
          <Spinner /> {busy}
        </p>
      )}
      {result && (
        <p className="mt-4 rounded-lg bg-white/5 p-3 text-sm" data-testid="restore-result">
          {result}
        </p>
      )}
      <div className="mt-5 flex justify-end">
        <Button variant="ghost" onClick={onClose} disabled={!!busy}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
