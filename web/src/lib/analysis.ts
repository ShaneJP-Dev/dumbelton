import type { MixdownRequest } from '../audio/import/mixdown.worker';
import { SAMPLE_RATE } from '../audio/core/types';
import { patchProjectById, syncGrid, syncProgram, toast } from '../state/actions';
import { getState } from '../state/store';
import { sectionsFromAnalysis, type AnalysisSection } from './sections';
import type { Project } from './types';

export interface AnalysisResult {
  backend: string;
  duration: number;
  bpm: number;
  beats: number[];
  downbeats: number[];
  sections: AnalysisSection[];
}

const API = '/api';
const running = new Set<string>();

export function isAnalyzing(id: string): boolean {
  return running.has(id);
}

function mixdown(project: Project): Promise<Blob> {
  const stems = project.stems.filter((s) => s.inAnalysisMix);
  const use = stems.length ? stems : project.stems;
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../audio/import/mixdown.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ type: 'done'; wav: ArrayBuffer } | { type: 'error'; message: string }>) => {
      w.terminate();
      if (e.data.type === 'done') resolve(new Blob([e.data.wav], { type: 'audio/wav' }));
      else reject(new Error(e.data.message));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'mixdown failed'));
    };
    const req: MixdownRequest = {
      songId: project.id,
      lengthFrames: project.lengthFrames,
      stems: use.map((s) => ({ id: s.id, channels: s.channels, length: s.length, present: s.present })),
    };
    w.postMessage(req);
  });
}

class AnalyzerUnavailable extends Error {}

async function postJob(wav: Blob): Promise<string> {
  const form = new FormData();
  form.append('audio', wav, 'mix.wav');
  let r: Response;
  try {
    r = await fetch(`${API}/jobs`, { method: 'POST', body: form });
  } catch {
    throw new AnalyzerUnavailable();
  }
  if (r.status === 502 || r.status === 503 || r.status === 504 || r.status === 404) throw new AnalyzerUnavailable();
  if (!r.ok) throw new Error(`analyzer error ${r.status}: ${await r.text()}`);
  return (await r.json()).id as string;
}

async function pollJob(id: string, onProgress: (p: number) => void): Promise<AnalysisResult> {
  for (;;) {
    await new Promise((res) => setTimeout(res, 800));
    let r: Response;
    try {
      r = await fetch(`${API}/jobs/${id}`);
    } catch {
      throw new AnalyzerUnavailable();
    }
    if (!r.ok) throw new Error(`analyzer error ${r.status}`);
    const job = await r.json();
    if (job.status === 'done') return job.result as AnalysisResult;
    if (job.status === 'error') throw new Error(job.error ?? 'analysis failed');
    onProgress(job.progress ?? 0);
  }
}

export function applyAnalysis(p: Project, res: AnalysisResult): Project {
  const sr = SAMPLE_RATE;
  const toF = (t: number) => Math.round(t * sr);
  const sections = sectionsFromAnalysis(res.sections, p.lengthFrames, sr);
  // arrangements keep only items whose sections still exist; the default one is rebuilt
  return {
    ...p,
    bpm: res.bpm,
    beats: res.beats.map(toF),
    downbeats: res.downbeats.map(toF),
    sections,
    arrangements: p.arrangements.map((a) => ({
      ...a,
      items: a.items.filter((it) => sections.some((s) => s.id === it.sectionId)),
    })),
    analysis: { status: 'done', backend: res.backend },
  };
}

/** Run structure analysis for a song in the background. */
export async function analyzeProject(project: Project): Promise<void> {
  if (running.has(project.id)) return;
  running.add(project.id);
  const id = project.id;
  try {
    await patchProjectById(id, (p) => ({ ...p, analysis: { status: 'running', progress: 0 } }));
    const wav = await mixdown(project);
    const jobId = await postJob(wav);
    const res = await pollJob(jobId, (progress) => {
      void patchProjectById(id, (p) => ({ ...p, analysis: { status: 'running', progress } }));
    });
    await patchProjectById(id, (p) => applyAnalysis(p, res));
    if (getState().current?.id === id) {
      syncGrid();
      syncProgram();
    }
  } catch (err) {
    const message =
      err instanceof AnalyzerUnavailable
        ? 'The analysis server is not running. Start it (see README), or mark sections by hand.'
        : String((err as Error).message ?? err);
    await patchProjectById(id, (p) => ({ ...p, analysis: { status: 'error', error: message } }));
    if (getState().current?.id === id) toast(message, 'error');
  } finally {
    running.delete(id);
  }
}
