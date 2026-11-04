import { SAMPLE_RATE } from '../audio/core/types';
import { deleteSongPcm, deleteStemPcm } from '../audio/import/pcmStore';
import type { TranscodeRequest } from '../audio/import/transcode.worker';
import { db } from './db';
import { uid } from './ids';
import { isGuideStem, stemColor, stemNamesFromFiles } from './stemNames';
import type { Project, Stem } from './types';

export const ACCEPTED_AUDIO = '.wav,.mp3,.m4a,.aac,.flac,.ogg,.aif,.aiff,audio/*';

export interface ImportProgress {
  index: number;
  total: number;
  file: string;
  stage: 'decoding' | 'converting' | 'done';
}

interface DoneMsg {
  type: 'done';
  stemId: string;
  channels: 1 | 2;
  length: number;
  present: Uint8Array;
  bytes: number;
  peaks: Int8Array[];
}

async function decodeFile(file: File): Promise<AudioBuffer> {
  const buf = await file.arrayBuffer();
  // decodeAudioData resamples to the context rate, so every stem lands at 48 kHz.
  const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  try {
    return await ctx.decodeAudioData(buf);
  } catch {
    throw new Error(`Could not read "${file.name}". Is it an audio file (WAV, MP3, M4A, FLAC)?`);
  }
}

function transcodeInWorker(worker: Worker, req: TranscodeRequest): Promise<DoneMsg> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<DoneMsg | { type: 'error'; message: string }>) => {
      if (e.data.type === 'done') resolve(e.data);
      else reject(new Error(e.data.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'audio conversion failed'));
    worker.postMessage(req, req.channels.map((c) => c.buffer as ArrayBuffer));
  });
}

/**
 * Decode, convert and store stems one at a time (never in parallel: a decoded
 * 5-minute stereo stem is ~115 MB of floats).
 */
async function importStems(
  songId: string,
  files: File[],
  names: string[],
  colorOffset: number,
  onProgress: (p: ImportProgress) => void,
): Promise<Stem[]> {
  const worker = new Worker(new URL('../audio/import/transcode.worker.ts', import.meta.url), { type: 'module' });
  const stems: Stem[] = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      onProgress({ index: i, total: files.length, file: file.name, stage: 'decoding' });
      const audio = await decodeFile(file);
      const channels: Float32Array[] = [];
      for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) channels.push(audio.getChannelData(c).slice());
      onProgress({ index: i, total: files.length, file: file.name, stage: 'converting' });
      const stemId = uid('t_');
      const res = await transcodeInWorker(worker, { type: 'transcode', songId, stemId, channels });
      await db.peaks.put({ stemId, songId, levels: res.peaks });
      const name = names[i];
      stems.push({
        id: stemId,
        name,
        color: stemColor(name, colorOffset + i),
        channels: res.channels,
        length: res.length,
        present: res.present,
        bytes: res.bytes,
        gain: 1,
        pan: 0,
        muted: false,
        solo: false,
        inAnalysisMix: !isGuideStem(name),
      });
    }
    onProgress({ index: files.length, total: files.length, file: '', stage: 'done' });
    return stems;
  } catch (err) {
    for (const s of stems) {
      await deleteStemPcm(songId, s.id);
      await db.peaks.delete(s.id);
    }
    throw err;
  } finally {
    worker.terminate();
  }
}

export async function importSong(
  name: string,
  files: File[],
  onProgress: (p: ImportProgress) => void,
): Promise<Project> {
  const songId = uid('s_');
  const names = stemNamesFromFiles(files.map((f) => f.name));
  let stems: Stem[];
  try {
    stems = await importStems(songId, files, names, 0, onProgress);
  } catch (err) {
    await deleteSongPcm(songId);
    throw err;
  }
  const now = Date.now();
  const project: Project = {
    id: songId,
    name: name.trim() || 'New song',
    createdAt: now,
    updatedAt: now,
    lengthFrames: Math.max(...stems.map((s) => s.length)),
    bpm: 0,
    beats: [],
    downbeats: [],
    stems,
    sections: [],
    arrangements: [],
    analysis: { status: 'none' },
  };
  await db.projects.put(project);
  return project;
}

/** Add more stems to an existing song. */
export async function addStems(
  project: Project,
  files: File[],
  onProgress: (p: ImportProgress) => void,
): Promise<Project> {
  const names = stemNamesFromFiles(files.map((f) => f.name));
  const stems = await importStems(project.id, files, names, project.stems.length, onProgress);
  const all = [...project.stems, ...stems];
  return {
    ...project,
    stems: all,
    lengthFrames: Math.max(project.lengthFrames, ...stems.map((s) => s.length)),
    updatedAt: Date.now(),
  };
}

export async function deleteProjectData(projectId: string): Promise<void> {
  await deleteSongPcm(projectId);
  await db.peaks.where('songId').equals(projectId).delete();
  await db.projects.delete(projectId);
}
