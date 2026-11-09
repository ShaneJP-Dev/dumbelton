import { useEffect, useRef } from 'react';
import { gainToDb } from '../audio/core/decibels';
import { deskChannels } from '../lib/outputs';
import type { Project } from '../lib/types';
import { navigate, setDeskListen } from '../state/actions';
import { peekEngine } from '../state/engine';
import { setState, useApp } from '../state/store';
import { Headphones, X } from './icons';
import { cx } from './ui';

const FLOOR = -60; // dB at the bottom of a meter
const FALL = 24; // dB per second
const HOLD_MS = 1500;
const TICKS = [0, -6, -12, -24, -48];
const pos = (db: number) => Math.max(0, Math.min(1, (db - FLOOR) / -FLOOR));

/**
 * Every output channel as the desk receives it: one strip per channel with a
 * live meter and the tracks on it. On a laptop (2 channels) you hear the full
 * mix, or tap Listen on a strip to hear just that channel.
 */
export function DeskPanel({ project }: { project: Project }) {
  const setup = useApp((s) => s.outputs);
  const deviceChannels = useApp((s) => s.outputChannels) ?? 2;
  const listen = useApp((s) => s.deskListen);
  const channels = deskChannels(setup, project.stems);
  const multitrack = setup.mode === 'multitrack';
  const laptop = deviceChannels <= 2;
  const canListen = multitrack && laptop;

  const strips = useRef<(HTMLDivElement | null)[]>([]);
  const masks = useRef<(HTMLDivElement | null)[]>([]);
  const holds = useRef<(HTMLDivElement | null)[]>([]);
  const chans = channels.map((c) => c.ch - 1).join(',');

  useEffect(() => {
    const list = chans.split(',').map(Number);
    let raf = 0;
    let last = performance.now();
    const shown = list.map(() => -Infinity);
    const held = list.map(() => -Infinity);
    const heldUntil = list.map(() => 0);
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const peaks = peekEngine()?.readChannelPeaks();
      list.forEach((ch, k) => {
        const db = gainToDb(peaks?.[ch] ?? 0);
        shown[k] = Math.max(db, shown[k] - FALL * dt);
        if (db >= held[k]) {
          held[k] = db;
          heldUntil[k] = now + HOLD_MS;
        } else if (now > heldUntil[k]) held[k] -= FALL * dt;
        const mask = masks.current[k];
        if (mask) mask.style.bottom = `${pos(shown[k]) * 100}%`;
        const hold = holds.current[k];
        if (hold) {
          hold.style.bottom = `calc(${pos(held[k]) * 100}% - 1px)`;
          hold.style.opacity = held[k] > FLOOR ? '1' : '0';
        }
        strips.current[k]?.setAttribute('data-level', shown[k] > FLOOR ? String(Math.round(shown[k])) : '-inf');
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [chans]);

  return (
    <section className="border-t border-white/10 bg-[#0c0f16] px-3 py-3 md:px-4" data-testid="desk-panel" aria-label="Desk">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">Desk</h2>
        <p className="min-w-0 flex-1 text-xs text-gray-400">
          {!multitrack ? (
            <>
              Outputs are in <b>Stereo</b> mode, so everything is on 1–2.{' '}
              <button type="button" className="underline hover:text-white" onClick={() => navigate({ name: 'outputs' })}>
                Switch to Multitrack
              </button>{' '}
              to see the church layout.
            </>
          ) : laptop ? (
            'What each channel of the church desk gets. This computer has 2 channels, so it plays the full mix; tap a headphone to hear one channel.'
          ) : (
            `What each channel of the desk gets (${deviceChannels} channels on this output).`
          )}
        </p>
        {canListen && (
          <button
            type="button"
            data-testid="desk-mix"
            aria-pressed={listen === null}
            onClick={() => setDeskListen(null)}
            className={cx(
              'h-8 rounded-lg px-3 text-xs font-medium ring-1',
              listen === null ? 'bg-sky-500/25 text-sky-100 ring-sky-400/50' : 'bg-white/5 text-gray-300 ring-white/10 hover:bg-white/10',
            )}
          >
            Hear the full mix
          </button>
        )}
        <button
          type="button"
          aria-label="Close the desk"
          onClick={() => setState({ deskOpen: false })}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-white/10 hover:text-white"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {channels.map((c, k) => {
          const listening = listen === c.ch;
          return (
            <div
              key={c.ch}
              ref={(el) => {
                strips.current[k] = el;
              }}
              data-testid="desk-strip"
              data-ch={c.ch}
              data-label={c.label}
              data-level="-inf"
              className={cx(
                'flex w-[4.5rem] shrink-0 flex-col items-center rounded-lg bg-white/5 px-1 py-1.5 ring-1',
                listening ? 'ring-sky-400' : 'ring-white/5',
              )}
            >
              <span className="text-[10px] font-semibold tabular-nums text-gray-500">{c.ch}</span>
              <span className="w-full truncate text-center text-[11px] font-semibold" title={c.label}>
                {c.label}
              </span>
              <div className="relative my-1.5 h-28 w-3 overflow-hidden rounded-sm bg-gradient-to-t from-green-500 from-70% via-yellow-400 via-[88%] to-red-500 to-95%">
                <div
                  ref={(el) => {
                    masks.current[k] = el;
                  }}
                  className="absolute top-0 right-0 left-0 bg-[#1b2030]"
                  style={{ bottom: '0%' }}
                />
                <div
                  ref={(el) => {
                    holds.current[k] = el;
                  }}
                  className="absolute right-0 left-0 h-0.5 bg-white"
                  style={{ bottom: '0%', opacity: 0 }}
                />
                {TICKS.map((t) => (
                  <span key={t} className="absolute right-0 left-0 h-px bg-black/40" style={{ bottom: `${pos(t) * 100}%` }} />
                ))}
              </div>
              <span
                className="h-7 w-full overflow-hidden text-center text-[10px] leading-[14px] text-gray-400"
                title={[...c.tracks, ...c.extras].join(', ') || 'Nothing on this channel in this song'}
              >
                {c.tracks.length ? c.tracks.join(', ') : c.extras.length ? <span className="text-gray-500">{c.extras.join(', ')}</span> : '—'}
              </span>
              <button
                type="button"
                data-testid="desk-listen"
                aria-pressed={listening}
                aria-label={`Listen to channel ${c.ch} (${c.label})`}
                disabled={!canListen}
                title={
                  canListen
                    ? listening
                      ? 'Back to the full mix'
                      : 'Hear only this channel on this computer'
                    : multitrack
                      ? 'Listening is only for a 2-channel output (a laptop): here outputs 1–2 are the desk’s own channels'
                      : 'Switch to Multitrack to listen to channels'
                }
                onClick={() => setDeskListen(listening ? null : c.ch)}
                className={cx(
                  'mt-1 flex h-7 w-full items-center justify-center rounded-md disabled:opacity-25',
                  listening ? 'bg-sky-500 text-black' : 'text-gray-300 hover:bg-white/10',
                )}
              >
                <Headphones size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
