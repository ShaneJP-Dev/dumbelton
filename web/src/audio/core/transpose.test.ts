import { describe, expect, it } from 'vitest';
import { LinkedWsola } from './LinkedWsola';
import { RenderCore } from './RenderCore';
import { LinkedResampler } from './Resampler';
import { stemFromFloat } from './StemBlocks';
import { buffers, decode, rampStem, song } from './testUtils';

const SR = 48000;

/** Frequency of a sine from its rising zero crossings (interpolated). */
function freqOf(x: ArrayLike<number>, from = 0, to = x.length): number {
  const times: number[] = [];
  for (let i = Math.max(1, from); i < to; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) times.push(i - 1 + x[i - 1] / (x[i - 1] - x[i]));
  }
  return ((times.length - 1) * SR) / (times[times.length - 1] - times[0]);
}

/** A pull that produces a continuous sine (as if from a stretcher), with source positions. */
function sinePull(freq: number) {
  let f = 0;
  return (n: number, out: Float32Array[][], pos: Float64Array) => {
    for (let i = 0; i < n; i++, f++) {
      const v = 0.5 * Math.sin((2 * Math.PI * freq * f) / SR);
      for (const s of out) {
        s[0][i] = v;
        s[1][i] = -v;
      }
      pos[i] = f;
    }
  };
}

describe('LinkedResampler', () => {
  it('raises the pitch by the ratio and advances positions at that rate', () => {
    const r = new LinkedResampler();
    const ratio = 2 ** (2 / 12);
    const pull = sinePull(440);
    const out = [[new Float32Array(SR), new Float32Array(SR)]];
    const pos = new Float64Array(SR);
    r.process(SR, out, pos, ratio, pull);
    expect(freqOf(out[0][0], 100)).toBeCloseTo(440 * ratio, 0);
    expect(freqOf(out[0][1], 100)).toBeCloseTo(440 * ratio, 0); // both channels, same weights
    expect(pos[SR - 1] - pos[1000]).toBeCloseTo((SR - 1 - 1000) * ratio, 3);
  });

  it('gives the same output however the work is split into blocks', () => {
    const ratio = 2 ** (-3 / 12);
    const whole = new LinkedResampler();
    const a = [[new Float32Array(4096), new Float32Array(4096)]];
    whole.process(4096, a, new Float64Array(4096), ratio, sinePull(300));
    const parts = new LinkedResampler();
    const pull = sinePull(300);
    const b: number[] = [];
    const o = [[new Float32Array(128), new Float32Array(128)]];
    const p = new Float64Array(128);
    for (let i = 0; i < 4096 / 128; i++) {
      parts.process(128, o, p, ratio, pull);
      b.push(...o[0][0]);
    }
    for (let i = 0; i < 4096; i++) expect(b[i]).toBeCloseTo(a[0][0][i], 6);
  });
});

describe('key change in the engine', () => {
  function sineCore(freq: number) {
    const x = new Float32Array(4 * SR);
    for (let f = 0; f < x.length; f++) x[f] = 0.5 * Math.sin((2 * Math.PI * freq * f) / SR);
    const core = new RenderCore(SR);
    core.setSong(song([stemFromFloat('sine', [x], { silenceThreshold: 0 })], x.length));
    core.setStretcher(new LinkedWsola(SR));
    return core;
  }

  function render(core: RenderCore, frames: number): Float32Array {
    const b = buffers(512, 1);
    const out = new Float32Array(frames);
    for (let done = 0; done < frames; done += 512) {
      core.render(b.main, 512);
      out.set(b.main[0].subarray(0, Math.min(512, frames - done)), done);
    }
    return out;
  }

  for (const [semis, speed] of [
    [2, 1],
    [-6, 1],
    [5, 0.75],
    [-2, 0.5],
  ] as const) {
    it(`${semis > 0 ? '+' : ''}${semis} semitones at ${speed * 100}% speed: pitch moves, tempo stays`, () => {
      const core = sineCore(440);
      core.setSpeed(speed);
      core.setTranspose(semis);
      core.play();
      const y = render(core, SR);
      expect(freqOf(y, 4800) / (440 * 2 ** (semis / 12))).toBeCloseTo(1, 2);
      // the music advances at `speed` (within the stretcher's read-ahead)
      expect(Math.abs(core.position.frame - SR * speed)).toBeLessThan(3000);
    });
  }

  it('back at 0 semitones and 100% the audio passes through untouched again', () => {
    const core = new RenderCore(SR);
    core.setSong(song([rampStem('r', SR)], SR));
    core.setStretcher(new LinkedWsola(SR));
    core.setTranspose(3);
    expect(core.getTranspose()).toBe(3);
    core.setTranspose(0);
    core.seek(1000);
    core.play();
    const b = buffers(256, 1);
    core.render(b.main, 256, b.stemOuts);
    for (let i = 0; i < 256; i++) expect(decode(b.stemOuts[0][0][i])).toBe(1000 + i);
  });

  for (const [semis, speed] of [
    [2, 1],
    [0, 0.5],
  ] as const) {
    it(`plays the very end of the song before reporting it ended (${semis} semitones, ${speed * 100}%)`, () => {
      const core = sineCore(440);
      core.setProgram({ segments: [{ id: 'a', start: 0, end: SR }], loop: false });
      core.setSpeed(speed);
      core.setTranspose(semis);
      let endedAt = -1;
      let rendered = 0;
      core.onEvent = (e) => {
        if (e.type === 'ended') endedAt = rendered;
      };
      core.play();
      const b = buffers(128, 1);
      let lastSound = 0;
      while (endedAt < 0 && rendered < 4 * SR) {
        core.render(b.main, 128);
        for (let i = 0; i < 128; i++) if (Math.abs(b.main[0][i]) > 0.01) lastSound = rendered + i;
        rendered += 128;
      }
      const expected = SR / speed;
      // sound right up to the end of the music, then 'ended'
      // the music plays out (the stretcher's grains make the tail a touch shorter than exact)
      expect(lastSound / expected).toBeGreaterThan(0.96);
      expect(lastSound / expected).toBeLessThan(1.01);
      // ...and 'ended' comes right after the last sound, not before
      expect(endedAt).toBeGreaterThanOrEqual(lastSound);
      expect(endedAt - lastSound).toBeLessThan(512);
    });
  }

  it('is limited to six semitones either way', () => {
    const core = new RenderCore(SR);
    core.setTranspose(9);
    expect(core.getTranspose()).toBe(6);
    core.setTranspose(-7.4);
    expect(core.getTranspose()).toBe(-6);
  });
});
