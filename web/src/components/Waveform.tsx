import { memo, useEffect, useRef, useState } from 'react';
import { PEAK_BASE, pickLevel } from '../audio/import/peaks';
import { db } from '../lib/db';

// peaks never change for a stem id; an arrangement draws the same stem many times
const peaksCache = new Map<string, Promise<Int8Array[] | null>>();
function loadPeaks(stemId: string): Promise<Int8Array[] | null> {
  let p = peaksCache.get(stemId);
  if (!p) {
    p = db.peaks.get(stemId).then((r) => r?.levels ?? null);
    peaksCache.set(stemId, p);
  }
  return p;
}

/** Canvas waveform for source frames [from, to) of one stem, drawn from the stored peaks pyramid. */
export const Waveform = memo(function Waveform({
  stemId,
  from,
  to,
  color,
  dim,
  width,
  height,
}: {
  stemId: string;
  from: number;
  to: number;
  color: string;
  dim: boolean;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Int8Array[] | null>(null);

  useEffect(() => {
    let alive = true;
    void loadPeaks(stemId).then((levels) => alive && setPeaks(levels));
    return () => {
      alive = false;
    };
  }, [stemId]);

  useEffect(() => {
    const c = ref.current;
    if (!c || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(width * dpr));
    const H = Math.round(height * dpr);
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, W, H);
    const span = to - from;
    if (!peaks || span <= 0) return;
    const fpp = span / W;
    const level = pickLevel(fpp);
    const bucket = PEAK_BASE * 4 ** level;
    const arr = peaks[level];
    const nb = arr.length / 2;
    const mid = H / 2;
    const scale = (H / 2 - 1) / 127;
    g.fillStyle = color;
    g.globalAlpha = dim ? 0.25 : 0.9;
    for (let x = 0; x < W; x++) {
      const b0 = Math.floor((from + x * fpp) / bucket);
      if (b0 >= nb) break;
      const b1 = Math.min(nb, Math.max(b0 + 1, Math.floor((from + (x + 1) * fpp) / bucket)));
      let mn = 0;
      let mx = 0;
      for (let b = b0; b < b1; b++) {
        if (arr[b * 2] < mn) mn = arr[b * 2];
        if (arr[b * 2 + 1] > mx) mx = arr[b * 2 + 1];
      }
      const y0 = mid - mx * scale;
      const y1 = mid - mn * scale;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }, [peaks, width, height, color, dim, from, to]);

  return <canvas ref={ref} style={{ width, height }} className="block" aria-hidden="true" />;
});
