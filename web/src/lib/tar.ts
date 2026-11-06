/**
 * Minimal streaming TAR (ustar) writer and reader for song backups.
 * Each file's size is in its 512-byte header, written before the data, so
 * reading never has to guess where a file ends (unlike streamed ZIP entries,
 * whose end is found by scanning for a signature that audio can contain).
 */

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

function writeStr(h: Uint8Array, off: number, len: number, s: string): void {
  const b = enc.encode(s);
  h.set(b.subarray(0, len), off);
}

function writeOctal(h: Uint8Array, off: number, len: number, n: number): void {
  // len-1 octal digits, then NUL
  writeStr(h, off, len - 1, n.toString(8).padStart(len - 1, '0'));
  h[off + len - 1] = 0;
}

/** Bytes of padding after a file of `size` bytes. */
export function tarPad(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/** The 512-byte header for a regular file. */
export function tarHeader(name: string, size: number, mtime = Math.floor(Date.now() / 1000)): Uint8Array {
  if (size > 0o77777777777) throw new Error(`file too large for a backup: ${name}`);
  let prefix = '';
  let base = name;
  if (enc.encode(name).length > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || enc.encode(name.slice(cut + 1)).length > 100) throw new Error(`path too long: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const h = new Uint8Array(BLOCK);
  writeStr(h, 0, 100, base);
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156); // checksum placeholder: spaces
  h[156] = 0x30; // '0' regular file
  writeStr(h, 257, 6, 'ustar');
  writeStr(h, 263, 2, '00');
  writeStr(h, 345, 155, prefix);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  writeStr(h, 148, 6, sum.toString(8).padStart(6, '0'));
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

/** Two zero blocks end an archive. */
export function tarEnd(): Uint8Array {
  return new Uint8Array(BLOCK * 2);
}

export type TarEvent =
  | { type: 'start'; name: string; size: number }
  | { type: 'data'; bytes: Uint8Array }
  | { type: 'end'; name: string }
  | { type: 'done' };

function readOctal(h: Uint8Array, off: number, len: number): number {
  const s = dec.decode(h.subarray(off, off + len)).replace(/\0.*$/s, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function readStr(h: Uint8Array, off: number, len: number): string {
  const end = h.subarray(off, off + len).indexOf(0);
  return dec.decode(h.subarray(off, end < 0 ? off + len : off + end));
}

/**
 * Push parser: feed chunks of any size, get events in order. `data` events
 * point into the pushed chunk; use them before the next push.
 */
export class TarReader {
  private header = new Uint8Array(BLOCK);
  private headerFill = 0;
  private remaining = 0; // file bytes still to come
  private skip = 0; // padding bytes still to skip
  private name = '';
  private inFile = false;
  private finished = false;
  private zeroBlocks = 0;

  get done(): boolean {
    return this.finished;
  }

  push(chunk: Uint8Array): TarEvent[] {
    const ev: TarEvent[] = [];
    let i = 0;
    while (i < chunk.length && !this.finished) {
      if (this.inFile) {
        const n = Math.min(this.remaining, chunk.length - i);
        if (n > 0) ev.push({ type: 'data', bytes: chunk.subarray(i, i + n) });
        i += n;
        this.remaining -= n;
        if (this.remaining === 0) {
          this.inFile = false;
          ev.push({ type: 'end', name: this.name });
        }
        continue;
      }
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - i);
        i += n;
        this.skip -= n;
        continue;
      }
      const n = Math.min(BLOCK - this.headerFill, chunk.length - i);
      this.header.set(chunk.subarray(i, i + n), this.headerFill);
      this.headerFill += n;
      i += n;
      if (this.headerFill < BLOCK) break;
      this.headerFill = 0;
      const h = this.header;
      if (h.every((b) => b === 0)) {
        if (++this.zeroBlocks >= 2) {
          this.finished = true;
          ev.push({ type: 'done' });
        }
        continue;
      }
      this.zeroBlocks = 0;
      // verify the checksum so a wrong file fails clearly
      const stored = readOctal(h, 148, 8);
      let sum = 0;
      for (let k = 0; k < BLOCK; k++) sum += k >= 148 && k < 156 ? 0x20 : h[k];
      if (stored !== sum) throw new Error('This file is not a backup (or it is damaged).');
      const prefix = readStr(h, 345, 155);
      const base = readStr(h, 0, 100);
      this.name = prefix ? `${prefix}/${base}` : base;
      const size = readOctal(h, 124, 12);
      const type = String.fromCharCode(h[156] || 0x30);
      this.skip = tarPad(size);
      if (type === '0' || type === '\0') {
        this.remaining = size;
        this.inFile = true;
        ev.push({ type: 'start', name: this.name, size });
        if (size === 0) {
          this.inFile = false;
          ev.push({ type: 'end', name: this.name });
        }
      } else {
        this.skip += size; // directories, links, etc.: ignore their contents
      }
    }
    return ev;
  }
}
