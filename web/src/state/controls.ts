import { seekTo } from '../components/Timeline';
import { sectionIndexAt } from '../lib/sections';
import { syncProgram } from './actions';
import { getEngine, peekEngine } from './engine';
import { getState, setState } from './store';

/**
 * Song controls shared by the keyboard and MIDI pedals. In Live a section is
 * queued (the engine moves straight there when stopped); elsewhere the
 * playhead moves to it.
 */
export function jumpToSection(i: number): void {
  const { current, mode, quantize } = getState();
  if (!current || i < 0 || i >= current.sections.length) return;
  if (mode === 'live') {
    void getEngine().then((e) => e.queueJump(i, quantize));
    return;
  }
  setState({ selected: current.sections[i].id });
  if (getState().loop) syncProgram();
  seekTo(current.sections[i].start);
}

/** The section playing (or queued next, in Live). */
export function currentSectionIndex(): number {
  const { current, mode, transport } = getState();
  if (!current) return 0;
  if (mode === 'live') return transport.pending?.to ?? transport.segment;
  return sectionIndexAt(current.sections, peekEngine()?.clock.now() ?? 0);
}

/** Next (+1) or previous (-1) section. */
export function stepSection(delta: number): void {
  jumpToSection(Math.max(0, currentSectionIndex() + delta));
}
