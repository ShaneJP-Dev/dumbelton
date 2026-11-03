/** WAV (PCM) encoding. */

export function wavHeader(dataBytes: number, channels: number, sampleRate: number, bits: 16 | 24): ArrayBuffer {
  const h = new ArrayBuffer(44);
  const v = new DataView(h);
  const bytesPerSample = bits / 8;
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bytesPerSample, true);
  v.setUint16(32, channels * bytesPerSample, true);
  v.setUint16(34, bits, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  return h;
}

/** Interleave planar float channels into PCM bytes (clipping at full scale). */
export function encodePcm(channels: Float32Array[], n: number, bits: 16 | 24, out?: Uint8Array): Uint8Array {
  const ch = channels.length;
  const bps = bits / 8;
  const buf = out ?? new Uint8Array(n * ch * bps);
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let x = channels[c][i];
      x = x > 1 ? 1 : x < -1 ? -1 : x;
      if (bits === 16) {
        const v = Math.round(x * 32767);
        buf[o++] = v & 0xff;
        buf[o++] = (v >> 8) & 0xff;
      } else {
        const v = Math.round(x * 8388607);
        buf[o++] = v & 0xff;
        buf[o++] = (v >> 8) & 0xff;
        buf[o++] = (v >> 16) & 0xff;
      }
    }
  }
  return buf;
}

export function encodeWav(channels: Float32Array[], sampleRate: number, bits: 16 | 24 = 16): ArrayBuffer {
  const n = channels[0].length;
  const data = encodePcm(channels, n, bits);
  const out = new Uint8Array(44 + data.byteLength);
  out.set(new Uint8Array(wavHeader(data.byteLength, channels.length, sampleRate, bits)), 0);
  out.set(data, 44);
  return out.buffer;
}

/** Minimal WAV reader for tests and verification (PCM 16/24-bit). */
export function decodeWav(buf: ArrayBuffer): { sampleRate: number; channels: Float32Array[] } {
  const v = new DataView(buf);
  const ch = v.getUint16(22, true);
  const sr = v.getUint32(24, true);
  const bits = v.getUint16(34, true);
  let off = 12;
  while (off < buf.byteLength - 8) {
    const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    const size = v.getUint32(off + 4, true);
    if (id === 'data') {
      const bps = bits / 8;
      const n = Math.floor(size / (bps * ch));
      const channels = Array.from({ length: ch }, () => new Float32Array(n));
      let o = off + 8;
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < ch; c++) {
          if (bits === 16) channels[c][i] = v.getInt16(o, true) / 32767;
          else {
            let x = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16);
            if (x & 0x800000) x |= ~0xffffff;
            channels[c][i] = x / 8388607;
          }
          o += bps;
        }
      }
      return { sampleRate: sr, channels };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}
