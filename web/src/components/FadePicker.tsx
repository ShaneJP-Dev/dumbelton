import { FADE_OPTIONS, fadeLabel } from '../lib/fade';
import { setFade } from '../state/actions';
import { useApp } from '../state/store';
import { cx } from './ui';

/** How jumps between parts sound: a clean cut, or a fade over 1 beat, 2 beats or 1 bar. */
export function FadePicker({ hasGrid }: { hasGrid: boolean }) {
  const fade = useApp((s) => s.fade);
  return (
    <div
      className="flex items-center gap-1 rounded-lg bg-white/5 p-1"
      role="group"
      aria-label="Fade between parts"
      title="Fade between parts. The new part still starts on its downbeat at full volume."
    >
      <span className="px-1.5 text-xs text-gray-400">Fade</span>
      {FADE_OPTIONS.map((b) => (
        <button
          key={b}
          type="button"
          aria-pressed={fade === b}
          data-testid={`fade-${b}`}
          onClick={() => setFade(b)}
          className={cx('h-8 rounded-md px-2.5 text-xs font-medium', fade === b ? 'bg-white/20 text-white' : 'text-gray-400 hover:text-white')}
        >
          {fadeLabel(b, hasGrid)}
        </button>
      ))}
    </div>
  );
}
