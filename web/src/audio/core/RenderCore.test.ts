import { describe, expect, it } from 'vitest';
import { RenderCore } from './RenderCore';
import { stemFromFloat } from './StemBlocks';
import { buffers, decode, PERIOD, rampStem, sineStem, song } from './testUtils';
import { XFADE_FRAMES, type CoreEvent } from './types';

const LEN = 48000;

function makeCore(nStems = 2, length = LEN) {
  const core = new RenderCore();
  const stems = Array.from({ length: nStems }, (_, i) => rampStem(`s${i}`, length, i % 2 ? 1 : 2));
  core.setSong(song(stems, length), { beats: [], downbeats: [] });
  const events: CoreEvent[] = [];
  core.onEvent = (e) => events.push(e);
  return { core, events };
}

function run(core: RenderCore, frames: number, nStems = 2, block = 128) {
  const out: number[][] = Array.from({ length: nStems }, () => []);
  const mainL: number[] = [];
  const b = buffers(block, nStems);
  for (let done = 0; done < frames; done += block) {
    const n = Math.min(block, frames - done);
    core.render(b.main, n, b.stemOuts);
    for (let s = 0; s < nStems; s++) for (let i = 0; i < n; i++) out[s].push(b.stemOuts[s][0][i]);
    for (let i = 0; i < n; i++) mainL.push(b.main[0][i]);
  }
  return { stems: out, mainL };
}

describe('RenderCore', () => {
  it('renders silence when stopped', () => {
    const { core } = makeCore();
    const { mainL } = run(core, 512);
    expect(mainL.every((v) => v === 0)).toBe(true);
  });

  it('keeps all stems sample-locked from the play position', () => {
    const { core } = makeCore(3);
    core.seek(1000);
    core.play();
    const { stems } = run(core, 3000, 3);
    for (let i = 0; i < 3000; i++) {
      const want = (1000 + i) % PERIOD;
      for (let s = 0; s < 3; s++) expect(decode(stems[s][i])).toBe(want);
    }
    expect(core.position.frame).toBe(4000);
  });

  it('ramps play in over 5 ms instead of clicking', () => {
    const { core } = makeCore(1);
    core.seek(3000);
    core.play();
    const { mainL } = run(core, 300, 1);
    expect(Math.abs(mainL[0])).toBeLessThan(0.01);
    expect(Math.abs(mainL[260])).toBeGreaterThan(0.05);
  });

  it('loops a segment with a crossfade that lands on the loop start', () => {
    const { core } = makeCore();
    core.setProgram({ segments: [{ id: 'a', start: 1000, end: 3000 }], loop: true });
    core.play();
    expect(core.position.frame).toBe(1000);
    run(core, 2000 - XFADE_FRAMES);
    expect(core.position.frame).toBe(3000 - XFADE_FRAMES);
    run(core, XFADE_FRAMES);
    expect(core.position.frame).toBe(1000);
    const { stems } = run(core, 100);
    expect(decode(stems[0][0])).toBe(1000);
    expect(decode(stems[1][99])).toBe(1099);
  });

  it('follows an arrangement of non-contiguous segments', () => {
    const { core } = makeCore();
    core.setProgram({
      segments: [
        { id: 'a', start: 0, end: 4000 },
        { id: 'c', start: 20000, end: 24000 },
        { id: 'a2', start: 0, end: 4000 },
      ],
      loop: false,
    });
    core.play();
    run(core, 4000);
    expect(core.position.segment).toBe(1);
    expect(core.position.frame).toBe(20000);
    run(core, 4000);
    expect(core.position.segment).toBe(2);
    expect(core.position.frame).toBe(0);
  });

  it('passes straight through contiguous segments without a crossfade', () => {
    const { core, events } = makeCore();
    core.setProgram({
      segments: [
        { id: 'a', start: 0, end: 4000 },
        { id: 'b', start: 4000, end: 8000 },
      ],
      loop: false,
    });
    core.play();
    const { stems } = run(core, 6000);
    for (let i = 3900; i < 4100; i++) expect(decode(stems[0][i])).toBe(i % PERIOD);
    expect(events).toContainEqual({ type: 'segment', index: 1 });
  });

  it('stops at the end of the program and reports it', () => {
    const { core, events } = makeCore(1, 10000);
    core.play();
    run(core, 10000 + 256, 1);
    expect(events.at(-1)).toEqual({ type: 'ended' });
    expect(core.isPlaying()).toBe(false);
    // play again restarts from the top
    core.play();
    expect(core.position.frame).toBe(0);
  });

  describe('queued jumps', () => {
    function liveCore() {
      const { core, events } = makeCore(2, 48000);
      core.setGrid({
        beats: Array.from({ length: 48 }, (_, i) => i * 1000),
        downbeats: Array.from({ length: 12 }, (_, i) => i * 4000),
      });
      core.setProgram({
        segments: [
          { id: 'v', start: 0, end: 8000 },
          { id: 'c', start: 8000, end: 16000 },
          { id: 'b', start: 16000, end: 24000 },
        ],
        loop: false,
      });
      core.play();
      return { core, events };
    }

    it('nextBar lands exactly on the target start at the next downbeat', () => {
      const { core, events } = liveCore();
      run(core, 1000);
      core.queueJump(2, 'nextBar');
      expect(events).toContainEqual({ type: 'armed', at: 4000, to: 2 });
      run(core, 4000 - XFADE_FRAMES - 1000);
      expect(core.position.segment).toBe(0);
      run(core, XFADE_FRAMES);
      expect(core.position.segment).toBe(2);
      expect(core.position.frame).toBe(16000);
      const { stems } = run(core, 10);
      expect(decode(stems[0][0])).toBe(16000 % PERIOD);
    });

    it('segmentEnd waits for the end of the current section', () => {
      const { core, events } = liveCore();
      run(core, 1000);
      core.queueJump(2, 'segmentEnd');
      expect(events).toContainEqual({ type: 'armed', at: 8000, to: 2 });
      run(core, 7000);
      expect(core.position.frame).toBe(16000);
    });

    it('the last tap wins and cancel works', () => {
      const { core } = liveCore();
      run(core, 500);
      core.queueJump(2, 'nextBar');
      core.queueJump(1, 'nextBar');
      expect(core.position.pending).toEqual({ at: 4000, to: 1 });
      run(core, 3500);
      expect(core.position.frame).toBe(8000);
      core.queueJump(2, 'segmentEnd');
      core.cancelJump();
      run(core, 8000);
      expect(core.position.segment).toBe(2); // natural, contiguous progression
      expect(core.position.frame).toBe(16000);
    });

    it('a jump close to the boundary uses a shorter crossfade but still lands on it', () => {
      const { core } = liveCore();
      run(core, 3900);
      core.queueJump(2, 'segmentEnd');
      run(core, 8000 - 3900);
      expect(core.position.frame).toBe(16000);
    });

    it('a quantised jump sent right after play still queues (the core decides, not the UI)', () => {
      const { core, events } = liveCore(); // liveCore() has just called play()
      core.queueJump(2, 'segmentEnd');
      expect(events).toContainEqual({ type: 'armed', at: 8000, to: 2 });
      run(core, 8000);
      expect(core.position.frame).toBe(16000);
    });

    it('during the count-in, a tapped section becomes the starting point', () => {
      const { core } = liveCore();
      core.pause();
      run(core, 512);
      core.play({ countIn: true });
      core.queueJump(1, 'segmentEnd');
      expect(core.position.frame).toBe(8000);
    });

    it('jumping while stopped moves straight to the section', () => {
      const { core } = liveCore();
      core.pause();
      run(core, 512);
      core.queueJump(1, 'nextBar');
      expect(core.position.frame).toBe(8000);
      expect(core.position.segment).toBe(1);
    });
  });

  it('crossfades keep jumps free of discontinuities', () => {
    const core = new RenderCore();
    const len = 96000;
    core.setSong({ id: 's', length: len, stems: [sineStem('a', len, 110)] });
    core.setProgram({
      segments: [
        { id: 'a', start: 0, end: 10000 },
        { id: 'b', start: 33333, end: 50000 },
      ],
      loop: false,
    });
    core.play();
    const { mainL } = run(core, 20000, 1);
    let maxDelta = 0;
    for (let i = 300; i < mainL.length; i++) maxDelta = Math.max(maxDelta, Math.abs(mainL[i] - mainL[i - 1]));
    const natural = (2 * Math.PI * 110 * 0.5) / 48000;
    expect(maxDelta).toBeLessThan(natural * 4);
  });

  it('mute and solo ramp rather than cut', () => {
    const core = new RenderCore();
    const len = 48000;
    const dc = (v: number) => stemFromFloat('dc', [new Float32Array(len).fill(v)], { silenceThreshold: 0 });
    core.setSong({ id: 's', length: len, stems: [dc(0.25), dc(0.5)] });
    core.play();
    run(core, 1024, 2);
    let { mainL } = run(core, 10, 2);
    expect(mainL[5]).toBeCloseTo(0.75, 3);
    core.setStem(1, { solo: true });
    ({ mainL } = run(core, 512, 2));
    expect(mainL[0]).toBeGreaterThan(0.7); // still ramping
    expect(mainL[400]).toBeCloseTo(0.5, 3);
    core.setStem(1, { mute: true });
    ({ mainL } = run(core, 512, 2));
    expect(mainL[400]).toBeCloseTo(0, 3); // soloed and muted -> silent
  });

  it('clicks exactly on beats, accented on downbeats', () => {
    const core = new RenderCore();
    const len = 48000;
    core.setSong({ id: 's', length: len, stems: [stemFromFloat('z', [new Float32Array(len)])] }, {
      beats: [1000, 2000, 3000, 4000, 5000],
      downbeats: [1000, 5000],
    });
    core.setClick({ enabled: true, gain: 1 });
    core.play();
    const { mainL } = run(core, 6000, 1);
    const firstNonZero = mainL.findIndex((v) => v !== 0);
    expect(firstNonZero).toBe(1001); // sin(0) = 0 at the onset sample itself
    expect(mainL.slice(900, 1000).every((v) => v === 0)).toBe(true);
    expect(mainL.slice(2001, 2030).some((v) => v !== 0)).toBe(true);
  });

  it('count-in plays one bar of clicks before the music', () => {
    const core = new RenderCore();
    const len = 96000;
    core.setSong({ id: 's', length: len, stems: [rampStem('a', len, 1)] }, {
      beats: Array.from({ length: 24 }, (_, i) => i * 4000),
      downbeats: Array.from({ length: 6 }, (_, i) => i * 16000),
    });
    core.play({ countIn: true });
    run(core, 16000, 1);
    expect(core.position.frame).toBe(0);
    run(core, 1000, 1);
    expect(core.position.frame).toBeGreaterThan(800);
  });

  it('setProgram keeps playing seamlessly when the position is inside the new program', () => {
    const { core } = makeCore();
    core.play();
    run(core, 2000);
    core.setProgram({ segments: [{ id: 'loop', start: 1000, end: 5000 }], loop: true });
    const { stems } = run(core, 100);
    expect(decode(stems[0][0])).toBe(2000);
  });
});

describe('stem volume', () => {
  it('applies a dB gain exactly once the ramp settles', async () => {
    const { dbToGain } = await import('./decibels');
    const core = new RenderCore();
    const len = 48000;
    core.setSong({ id: 's', length: len, stems: [stemFromFloat('dc', [new Float32Array(len).fill(0.5)], { silenceThreshold: 0 })] });
    core.play();
    const main = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 4; i++) core.render(main, 128);
    const dc = main[0][64];
    core.setStem(0, { gain: dbToGain(-6) });
    for (let i = 0; i < 4; i++) core.render(main, 128); // 5 ms ramp
    expect(main[0][100] / dc).toBeCloseTo(dbToGain(-6), 6);
    expect(main[0][127]).toBe(main[0][0]); // settled: constant
    core.setStem(0, { gain: 0 });
    for (let i = 0; i < 4; i++) core.render(main, 128);
    expect(main[0][127]).toBe(0);
  });
});
