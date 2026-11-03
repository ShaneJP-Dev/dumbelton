import { useEffect, useRef, useState } from 'react';
import { peekEngine } from '../state/engine';

/**
 * Call `cb(frame, playing)` every animation frame with the audible position.
 * For imperative DOM updates (transforms), so React does not re-render at 60 fps.
 */
export function usePlayhead(cb: (frame: number, playing: boolean) => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    let raf = 0;
    let last = -1;
    let lastPlaying = false;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const e = peekEngine();
      if (!e) return;
      const f = e.clock.now();
      const playing = e.clock.playing;
      if (f !== last || playing !== lastPlaying) {
        last = f;
        lastPlaying = playing;
        ref.current(f, playing);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
}

/** A value derived from the playhead that only re-renders when it changes (e.g. the current section). */
export function usePlayheadValue<T>(fn: (frame: number, playing: boolean) => T, initial: T): T {
  const [v, setV] = useState<T>(initial);
  const last = useRef<T>(initial);
  usePlayhead((f, p) => {
    const next = fn(f, p);
    if (next !== last.current) {
      last.current = next;
      setV(next);
    }
  });
  return v;
}

/** Track an element's content width. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
