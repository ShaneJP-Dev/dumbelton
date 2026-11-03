import { useState } from 'react';
import { dbToFader, dbToGain, faderToDb, formatDb, gainToDb, parseDb } from '../audio/core/decibels';
import { cx } from './ui';

const STEPS = 1000;
/** Positions this close to 0 dB snap to exactly 0 dB while dragging. */
const DETENT_DB = 0.3;

/**
 * Horizontal volume fader with a dB readout. Tap the readout to type a value
 * ("-6", "+2", "-inf"); double-click the fader to reset to 0 dB.
 */
export function VolumeFader({ gain, label, onChange, dim }: { gain: number; label: string; onChange: (gain: number) => void; dim?: boolean }) {
  const db = gainToDb(gain);
  const pos = Math.round(dbToFader(db) * STEPS);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');

  const commit = () => {
    const v = parseDb(text);
    if (v !== null) onChange(dbToGain(v));
    setEditing(false);
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="relative flex h-6 min-w-0 flex-1 items-center">
        {/* 0 dB mark */}
        <div className="pointer-events-none absolute top-1 bottom-1 w-px bg-white/35" style={{ left: '80%' }} aria-hidden="true" />
        <input
          type="range"
          min={0}
          max={STEPS}
          step={1}
          value={pos}
          aria-label={`${label} volume`}
          aria-valuetext={formatDb(db)}
          title={`${formatDb(db)} (double-click for 0 dB)`}
          onChange={(e) => {
            let d = faderToDb(Number(e.target.value) / STEPS);
            if (Math.abs(d) < DETENT_DB) d = 0;
            onChange(dbToGain(d));
          }}
          onDoubleClick={() => onChange(1)}
          className={cx('fader w-full', dim && 'opacity-50')}
          style={{ ['--fill' as string]: `${(pos / STEPS) * 100}%` }}
        />
      </div>
      {editing ? (
        <input
          autoFocus
          value={text}
          aria-label={`${label} volume in dB`}
          data-testid="db-input"
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="h-6 w-[58px] shrink-0 rounded bg-white/15 px-1 text-right text-[11px] tabular-nums outline-none focus:ring-1 focus:ring-blue-500"
        />
      ) : (
        <button
          type="button"
          data-testid="db-readout"
          title="Tap to type a volume in dB"
          aria-label={`${label} volume ${formatDb(db)}, tap to type a value`}
          onClick={() => {
            setText(db === -Infinity ? '-inf' : (Math.round(db * 10) / 10).toString());
            setEditing(true);
          }}
          className={cx(
            'h-6 w-[58px] shrink-0 whitespace-nowrap rounded px-1 text-right text-[11px] tabular-nums hover:bg-white/10',
            db > 0 ? 'text-amber-300' : db === -Infinity ? 'text-gray-500' : 'text-gray-300',
          )}
        >
          {formatDb(db)}
        </button>
      )}
    </div>
  );
}
