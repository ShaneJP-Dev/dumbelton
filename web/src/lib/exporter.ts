import type { ExportReply, ExportRequest } from '../audio/export/export.worker';
import type { Program } from '../audio/core/types';
import type { Project } from './types';

export interface ExportOptions {
  mix: boolean;
  stemFiles: boolean;
  speed: number;
  click: boolean;
  /** Fade length (frames) at arrangement joins. */
  transition: number;
}

export interface ExportedFile {
  name: string;
  file: File;
}

/** Render a program in a worker; returns the files written to OPFS. */
export function exportProgram(
  project: Project,
  program: Program,
  baseName: string,
  opts: ExportOptions,
  onProgress: (fraction: number, stage: 'render' | 'zip') => void,
): Promise<{ files: ExportedFile[]; clipped: boolean; frames: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../audio/export/export.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = async (e: MessageEvent<ExportReply>) => {
      const m = e.data;
      if (m.type === 'progress') return onProgress(m.fraction, m.stage);
      w.terminate();
      if (m.type === 'error') return reject(new Error(m.message));
      try {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('exports');
        const files = await Promise.all(
          m.files.map(async (f) => {
            const raw = await (await dir.getFileHandle(f.path)).getFile();
            return { name: f.name, file: new File([raw], f.name, { type: raw.type || (f.name.endsWith('.zip') ? 'application/zip' : 'audio/wav') }) };
          }),
        );
        resolve({ files, clipped: m.clipped, frames: m.frames });
      } catch (err) {
        reject(err);
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'export failed'));
    };
    const req: ExportRequest = {
      songId: project.id,
      baseName,
      stems: project.stems.map((s) => ({
        id: s.id,
        name: s.name,
        channels: s.channels,
        length: s.length,
        present: s.present,
        gain: s.gain,
        pan: s.pan,
        muted: s.muted,
        solo: s.solo,
      })),
      grid: { beats: project.beats, downbeats: project.downbeats },
      program,
      ...opts,
    };
    w.postMessage(req);
  });
}

/** Save a file: share sheet on iPad/iPhone, download elsewhere. */
export async function saveFile(f: ExportedFile): Promise<void> {
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  const touch = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
  if (touch && nav.canShare?.({ files: [f.file] })) {
    try {
      await navigator.share({ files: [f.file], title: f.name });
      return;
    } catch {
      /* cancelled; fall back to download */
    }
  }
  const url = URL.createObjectURL(f.file);
  const a = document.createElement('a');
  a.href = url;
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
