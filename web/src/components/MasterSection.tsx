import { useEffect, useRef, useState } from 'react';
import { formatDb, gainToDb } from '../audio/core/decibels';
import type { Project } from '../lib/types';
import { patchProject, syncStems } from '../state/actions';
import { peekEngine } from '../state/engine';
import { cx } from './ui';
import { VolumeFader } from './VolumeFader';

const FLOOR = -60; // dB at the left edge of the meter
const FALL = 24; // dB per second
const HOLD_MS = 1500;
const TICKS = [-24, -12, -6, 0];

const pos = (db: number) => Math.max(0, Math.min(1, (db - FLOOR) / -FLOOR));

/**
 * Live level of the whole song in dB (L and R): falling bars, a peak-hold
 * mark, the recent peak as a number, and a CLIP light that stays on until tapped.
 */
export function LevelMeter() {
  const root = useRef<HTMLDivElement>(null);
  const masks = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const holds = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const readout = useRef<HTMLSpanElement>(null);
  const [clip, setClip] = useState(false);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const shown = [-Infinity, -Infinity];
    const held = [-Infinity, -Infinity];
    const heldUntil = [0, 0];
    let clipped = false;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const m = peekEngine()?.readMeter() ?? { l: 0, r: 0, clip: false };
      const peaks = [gainToDb(m.l), gainToDb(m.r)];
      for (let c = 0; c < 2; c++) {
        shown[c] = Math.max(peaks[c], shown[c] - FALL * dt);
        if (peaks[c] >= held[c]) {
          held[c] = peaks[c];
          heldUntil[c] = now + HOLD_MS;
        } else if (now > heldUntil[c]) {
          held[c] -= FALL * dt;
        }
        const mask = masks[c].current;
        if (mask) mask.style.left = `${pos(shown[c]) * 100}%`;
        const hold = holds[c].current;
        if (hold) {
          hold.style.left = `calc(${pos(held[c]) * 100}% - 1px)`;
          hold.style.opacity = held[c] > FLOOR ? '1' : '0';
        }
      }
      const top = Math.max(held[0], held[1]);
      if (readout.current) readout.current.textContent = top > FLOOR ? formatDb(top).replace(' dB', '') : '−∞';
      root.current?.setAttribute('data-db', String(Math.round(Math.max(shown[0], shown[1], FLOOR - 1))));
      if (m.clip && !clipped) {
        clipped = true;
        setClip(true);
      }
    };
    raf = requestAnimationFrame(tick);
    const reset = () => {
      clipped = false;
    };
    window.addEventListener('meter-clip-reset', reset);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('meter-clip-reset', reset);
    };
  }, []); // refs are stable

  return (
    <div className="flex items-center gap-1.5" ref={root} data-testid="level-meter" title="Song level (peak, dBFS)">
      <div className="relative w-24 sm:w-36">
        {[0, 1].map((c) => (
          <div key={c} className="relative mb-0.5 h-2 overflow-hidden rounded-sm bg-gradient-to-r from-green-500 from-70% via-yellow-400 via-[88%] to-red-500 to-95%">
            <div ref={masks[c]} className="absolute top-0 right-0 bottom-0 bg-[#1b2030]" style={{ left: '0%' }} />
            <div ref={holds[c]} className="absolute top-0 bottom-0 w-0.5 bg-white" style={{ left: '0%', opacity: 0 }} />
          </div>
        ))}
        <div className="relative h-3 text-[9px] leading-3 text-gray-500">
          {TICKS.map((t) => (
            <span key={t} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${pos(t) * 100}%` }}>
              {t === 0 ? '0' : t}
            </span>
          ))}
        </div>
      </div>
      <span ref={readout} className="hidden w-9 text-right text-[11px] tabular-nums text-gray-300 sm:inline" data-testid="meter-peak">
        −∞
      </span>
      <button
        type="button"
        onClick={() => {
          setClip(false);
          window.dispatchEvent(new Event('meter-clip-reset'));
        }}
        aria-label={clip ? 'Clipped! Tap to reset' : 'No clipping'}
        data-testid="clip-light"
        data-clip={clip}
        className={cx(
          'h-6 rounded px-1.5 text-[10px] font-bold tracking-wide',
          clip ? 'bg-red-600 text-white' : 'bg-white/5 text-gray-600',
        )}
        title={clip ? 'The output went over 0 dB. Lower the master or some tracks, then tap to reset.' : 'Lights up if the output goes over 0 dB'}
      >
        CLIP
      </button>
    </div>
  );
}

/** Master fader (saved with the song) and the song's level meter. */
export function MasterSection({ project }: { project: Project }) {
  const gain = project.masterGain ?? 1;
  return (
    <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto" data-testid="master">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Master</span>
      <div className="w-[130px] shrink-0 sm:w-[170px]">
        <VolumeFader
          gain={gain}
          label="Master"
          onChange={(g) => {
            patchProject((p) => ({ ...p, masterGain: g }));
            syncStems();
          }}
        />
      </div>
      <LevelMeter />
    </div>
  );
}
