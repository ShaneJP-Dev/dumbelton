import type { MixdownRequest } from '../audio/import/mixdown.worker';
import { SAMPLE_RATE } from '../audio/core/types';
import { patchProjectById, syncGrid, syncProgram, toast } from '../state/actions';
import { getState } from '../state/store';
import { guideMessage, guideStems, type GuideResult } from './guide';
import { detectedKey, keyName } from './musicKey';
import { sectionsFromAnalysis, type AnalysisSection } from './sections';
import type { Project, Stem } from './types';

export interface AnalysisResult {
  backend: string;
  duration: number;
  bpm: number;
  beats: number[];
  downbeats: number[];
  sections: AnalysisSection[];
  /** "guide" when the guide track's spoken cues placed the sections. */
  sectionsFrom?: 'guide' | 'audio';
  /** Present when a guide track was sent. */
  guide?: GuideResult;
  /** The song's key, estimated from the mix (null if it has no clear pitch). */
  key?: { tonic: number; mode: 'major' | 'minor'; name: string; confidence: number } | null;
}

const API = '/api';
const running = new Set<string>();

export function isAnalyzing(id: string): boolean {
  return running.has(id);
}

/** The tracks that make up the analysis mix (everything but click and guide). */
function analysisStems(project: Project): Stem[] {
  const forMix = project.stems.filter((s) => s.inAnalysisMix);
  return forMix.length ? forMix : project.stems;
}

/** Mono WAV of some of a song's tracks (summed, peak-normalised). */
function mixdown(project: Project, use: Stem[]): Promise<Blob> {
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

async function postJob(wav: Blob, guide: Blob | null): Promise<string> {
  const form = new FormData();
  form.append('audio', wav, 'mix.wav');
  if (guide) form.append('guide', guide, 'guide.wav');
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
    // a key chosen by hand is never replaced
    key: p.key?.source === 'set' ? p.key : (detectedKey(res.key) ?? p.key),
    arrangements: p.arrangements.map((a) => ({
      ...a,
      items: a.items.filter((it) => sections.some((s) => s.id === it.sectionId)),
    })),
    analysis: {
      status: 'done',
      backend: res.backend,
      source: res.sectionsFrom ?? 'audio',
      guideLanguage: res.guide?.status === 'ok' ? res.guide.language : undefined,
    },
  };
}

/** Run structure analysis for a song in the background. */
export async function analyzeProject(project: Project): Promise<void> {
  if (running.has(project.id)) return;
  running.add(project.id);
  const id = project.id;
  try {
    await patchProjectById(id, (p) => ({ ...p, analysis: { status: 'running', progress: 0 } }));
    const wav = await mixdown(project, analysisStems(project));
    // the guide track alone, so the analyzer can read its spoken cues ("Verse", "Chorus"…)
    const guide = guideStems(project.stems, getState().outputs);
    const guideWav = guide.length ? await mixdown(project, guide) : null;
    const jobId = await postJob(wav, guideWav);
    const res = await pollJob(jobId, (progress) => {
      void patchProjectById(id, (p) => ({ ...p, analysis: { status: 'running', progress } }));
    });
    await patchProjectById(id, (p) => applyAnalysis(p, res));
    if (getState().current?.id === id) {
      syncGrid();
      syncProgram();
      const note = guideMessage(res.guide, res.sectionsFrom);
      if (note) toast(note.text, note.kind);
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

/**
 * Find the key of a song analysed before keys were detected (the sections are
 * left alone). Returns the key name, or null if the music has no clear key.
 */
export async function findKey(project: Project): Promise<string | null> {
  const wav = await mixdown(project, analysisStems(project));
  const form = new FormData();
  form.append('audio', wav, 'mix.wav');
  let r: Response;
  try {
    r = await fetch(`${API}/key`, { method: 'POST', body: form });
  } catch {
    throw new AnalyzerUnavailable();
  }
  if (r.status === 502 || r.status === 503 || r.status === 504 || r.status === 404) throw new AnalyzerUnavailable();
  if (!r.ok) throw new Error(`analyzer error ${r.status}`);
  const key = detectedKey((await r.json()).key);
  if (!key) return null;
  await patchProjectById(project.id, (p) => (p.key?.source === 'set' ? p : { ...p, key }));
  return keyName(key);
}

export { AnalyzerUnavailable };
