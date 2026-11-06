import { describe, expect, it } from 'vitest';
import { TarReader, tarEnd, tarHeader, tarPad, type TarEvent } from './tar';

function archive(files: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, data] of files) {
    parts.push(tarHeader(name, data.length, 1700000000), data, new Uint8Array(tarPad(data.length)));
  }
  parts.push(tarEnd());
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function readAll(tar: Uint8Array, chunk: number) {
  const r = new TarReader();
  const files = new Map<string, number[]>();
  let current = '';
  const events: TarEvent['type'][] = [];
  for (let i = 0; i < tar.length; i += chunk) {
    for (const e of r.push(tar.subarray(i, i + chunk))) {
      events.push(e.type);
      if (e.type === 'start') {
        current = e.name;
        files.set(current, []);
      } else if (e.type === 'data') files.get(current)!.push(...e.bytes);
    }
  }
  return { files, done: r.done, events };
}

describe('tar', () => {
  // audio-like bytes that contain ZIP signatures, which broke streamed ZIP reading
  const audio = new Uint8Array(70001).map((_, i) => (i * 37) % 256);
  audio.set([0x50, 0x4b, 0x07, 0x08, 0, 0, 0, 0, 0x34, 0x12, 0, 0], 3000);
  audio.set([0x50, 0x4b, 0x03, 0x04], 60000);
  const manifest = new TextEncoder().encode('{"app":"musical"}');
  const empty = new Uint8Array(0);

  it.each([1, 7, 512, 1000, 65536])('round-trips files exactly when read in %i-byte chunks', (chunk) => {
    const t = archive([
      ['manifest.json', manifest],
      ['songs/s_abc/t_def.pcm', audio],
      ['peaks/t_def/0.bin', empty],
    ]);
    expect(t.length % 512).toBe(0);
    const { files, done } = readAll(t, chunk);
    expect(done).toBe(true);
    expect([...files.keys()]).toEqual(['manifest.json', 'songs/s_abc/t_def.pcm', 'peaks/t_def/0.bin']);
    expect(Uint8Array.from(files.get('songs/s_abc/t_def.pcm')!)).toEqual(audio);
    expect(new TextDecoder().decode(Uint8Array.from(files.get('manifest.json')!))).toBe('{"app":"musical"}');
    expect(files.get('peaks/t_def/0.bin')!.length).toBe(0);
  });

  it('handles long paths with the ustar prefix', () => {
    const long = `songs/${'a'.repeat(80)}/${'b'.repeat(60)}.pcm`;
    const { files } = readAll(archive([[long, manifest]]), 333);
    expect([...files.keys()]).toEqual([long]);
  });

  it('rejects files that are not tar', () => {
    const notTar = new Uint8Array(2048).map((_, i) => (i * 13) % 251);
    expect(() => new TarReader().push(notTar)).toThrow(/not a backup/);
  });
});
