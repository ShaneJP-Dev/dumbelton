import { SAMPLE_RATE } from '../audio/core/types';
import { KINDS } from './sections';

/** Languages the analyzer can speak cue words in. */
export type CueLang = 'en' | 'es';

export interface VoiceBank {
  lang: CueLang;
  /** The computer voice that made the words. */
  voice: string;
  /** One clip per section kind, in KINDS order (empty when missing). Mono, engine sample rate. */
  clips: Float32Array[];
}

/** Decode a PCM (16/24/32-bit) or float WAV to mono samples. */
export function parseWav(buf: ArrayBuffer): { rate: number; samples: Float32Array } {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let o = 12;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before format');
      const { format, channels, rate, bits } = fmt;
      const bytes = bits / 8;
      const end = Math.min(buf.byteLength, body + size);
      const frames = Math.floor((end - body) / (bytes * channels));
      const out = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const p = body + (f * channels + c) * bytes;
          if (format === 3 && bits === 32) sum += v.getFloat32(p, true);
          else if (bits === 16) sum += v.getInt16(p, true) / 32768;
          else if (bits === 24) sum += ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16)) / 8388608);
          else if (bits === 32) sum += v.getInt32(p, true) / 2147483648;
          else throw new Error(`unsupported WAV: ${bits}-bit`);
        }
        out[f] = sum / channels;
      }
      return { rate, samples: out };
    }
    o = body + size + (size % 2);
  }
  throw new Error('WAV has no audio');
}

/** Linear resample to the engine rate (cue words only: quality is not critical). */
export function toEngineRate(samples: Float32Array, rate: number): Float32Array {
  if (rate === SAMPLE_RATE || samples.length === 0) return samples;
  const n = Math.round((samples.length * SAMPLE_RATE) / rate);
  const out = new Float32Array(n);
  const step = rate / SAMPLE_RATE;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const k = Math.floor(x);
    const t = x - k;
    out[i] = (samples[k] ?? 0) * (1 - t) + (samples[k + 1] ?? samples[k] ?? 0) * t;
  }
  return out;
}

const banks = new Map<CueLang, Promise<VoiceBank>>();

/**
 * The cue words in `lang`, made by the analysis server with the computer's own
 * voice (the first time takes a few seconds). Rejects with a readable reason.
 */
export function loadVoice(lang: CueLang): Promise<VoiceBank> {
  let p = banks.get(lang);
  if (!p) {
    p = (async () => {
      let info: { available: boolean; voice?: string; message?: string; kinds: string[] };
      try {
        const r = await fetch(`/api/voice/${lang}`);
        if (!r.ok) throw new Error(String(r.status));
        info = await r.json();
      } catch {
        throw new Error("the analysis server isn't running");
      }
      if (!info.available) throw new Error(info.message ?? 'no voice');
      const clips = await Promise.all(
        KINDS.map(async (kind) => {
          if (!info.kinds.includes(kind)) return new Float32Array(0);
          const r = await fetch(`/api/voice/${lang}/${kind}.wav`);
          if (!r.ok) return new Float32Array(0);
          const { rate, samples } = parseWav(await r.arrayBuffer());
          return toEngineRate(samples, rate);
        }),
      );
      return { lang, voice: info.voice ?? '', clips };
    })();
    banks.set(lang, p);
    p.catch(() => banks.delete(lang)); // try again next time (e.g. the server was started)
  }
  return p;
}
