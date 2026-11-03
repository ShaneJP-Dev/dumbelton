import { describe, expect, it } from 'vitest';
import { RenderCore } from './RenderCore';
import { stemFromFloat } from './StemBlocks';
import { programLength, renderProgram } from '../export/render';
import { XFADE_FRAMES } from './types';

const SR = 48000;
// a mono stem whose level tells you which section is playing: 0.1, 0.3, 0.5, 0.7 per 8000 frames
function steppedSong() {
  const len = 48000;
  const x = new Float32Array(len);
  for (let f = 0; f < len; f++) x[f] = [0.1, 0.3, 0.5, 0.7, 0.9, 0.2][Math.floor(f / 8000)];
  const core = new RenderCore(SR);
  core.setSong({ id: 's', length: len, stems: [stemFromFloat('a', [x], { silenceThreshold: 0 })] }, {
    beats: Array.from({ length: 48 }, (_, i) => i * 1000),
    downbeats: Array.from({ length: 12 }, (_, i) => i * 4000),
  });
  return core;
}

function render(core: RenderCore, frames: number): number[] {
  const main = [new Float32Array(128), new Float32Array(128)];
  const out: number[] = [];
  for (let done = 0; done < frames; done += 128) {
    const n = Math.min(128, frames - done);
    core.render(main, n);
    for (let i = 0; i < n; i++) out.push(main[0][i]);
  }
  return out;
}

const sections = {
  segments: [
    { id: 'a', start: 0, end: 8000 },
    { id: 'b', start: 8000, end: 16000 },
    { id: 'c', start: 16000, end: 24000 },
    { id: 'd', start: 24000, end: 32000 },
  ],
  loop: false,
};

describe('fades between parts', () => {
  it('a Live jump fades over the chosen length and lands on the target at full level', () => {
    const core = steppedSong();
    core.setProgram(sections);
    core.setTransition(4000); // fade 1 bar (4000 frames here)
    core.play();
    render(core, 1000);
    core.queueJump(3, 'segmentEnd'); // from section a (ends 8000) to d (starts 24000)
    const out = render(core, 9000); // frames 1000..10000
    const at = (f: number) => out[f - 1000];
    expect(at(3900)).toBeCloseTo(0.1, 3); // before the fade: only the current part
    // mid-fade: both parts audible (a fading out, d's lead-in fading in)
    const mid = at(6000);
    expect(mid).toBeGreaterThan(0.1 * 0.6);
    expect(mid).toBeLessThan(0.1 * 0.8 + 0.5 * 0.8);
    expect(at(8100)).toBeCloseTo(0.7, 3); // target part at full level from its first downbeat
    expect(core.position.segment).toBe(3);
  });

  it('a cut is a 10 ms crossfade', () => {
    const core = steppedSong();
    core.setProgram(sections);
    core.setTransition(0);
    expect(core.getTransition()).toBe(XFADE_FRAMES);
    core.play();
    render(core, 1000);
    core.queueJump(3, 'segmentEnd');
    const out = render(core, 9000);
    expect(out[8000 - XFADE_FRAMES - 1 - 1000]).toBeCloseTo(0.1, 3);
  });

  it('arrangement joins fade; loops stay tight', () => {
    const core = steppedSong();
    core.setTransition(4000);
    core.setProgram({ segments: [{ id: 'a', start: 0, end: 8000 }, { id: 'c', start: 16000, end: 24000 }], loop: false });
    core.play();
    const out = render(core, 9000);
    expect(out[3900]).toBeCloseTo(0.1, 3);
    expect(out[6000]).toBeGreaterThan(0.1 * 0.6);
    expect(out[8100]).toBeCloseTo(0.5, 3);

    const loop = steppedSong();
    loop.setTransition(4000);
    loop.setProgram({ segments: [{ id: 'b', start: 8000, end: 16000 }], loop: true });
    loop.play();
    const l = render(loop, 8000);
    expect(l[6000]).toBeCloseTo(0.3, 3); // no long fade before the loop point
  });

  it('changing the fade re-times a queued jump', () => {
    const core = steppedSong();
    core.setProgram(sections);
    core.play();
    render(core, 1000);
    core.queueJump(2, 'segmentEnd');
    core.setTransition(4000);
    const out = render(core, 6000); // frames 1000..7000
    expect(out[6000 - 1000]).toBeGreaterThan(0.1 * 0.6); // already fading at 6000
    render(core, 1000);
    expect(core.position.frame).toBe(16000);
  });

  it('exports are the same length with fades', () => {
    const core = steppedSong();
    core.setTransition(4000);
    const program = { segments: [{ id: 'c', start: 16000, end: 24000 }, { id: 'a', start: 0, end: 8000 }, { id: 'c2', start: 16000, end: 24000 }], loop: false };
    const n = renderProgram(core, program, { speed: 1, onBlock: () => undefined });
    expect(n).toBe(programLength(program));
  });
});
