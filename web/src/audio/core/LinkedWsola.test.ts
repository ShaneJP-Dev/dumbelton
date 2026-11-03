import { describe, expect, it } from 'vitest';
import { LinkedWsola } from './LinkedWsola';
import { RenderCore } from './RenderCore';
import { stemFromFloat } from './StemBlocks';
import { decode, PERIOD, rampStem, sineStem } from './testUtils';

const SR = 48000;

function offsetRampStem(id: string, length: number, offset: number) {
  const x = new Float32Array(length);
  for (let f = 0; f < length; f++) x[f] = (((f + offset) % PERIOD) / PERIOD) * 0.9 - 0.45 + 0.0001;
  return stemFromFloat(id, [x], { silenceThreshold: 0 });
}

function setup(stems: ReturnType<typeof rampStem>[], length: number) {
  const core = new RenderCore(SR);
  const wsola = new LinkedWsola(SR);
  core.setSong({ id: 's', length, stems });
  core.setStretcher(wsola);
  return { core, wsola };
}

function render(core: RenderCore, frames: number, nStems: number, block = 128) {
  const main = [new Float32Array(block), new Float32Array(block)];
  const so = Array.from({ length: nStems }, () => [new Float32Array(block), new Float32Array(block)]);
  const stems: number[][] = Array.from({ length: nStems }, () => []);
  const mainL: number[] = [];
  for (let done = 0; done < frames; done += block) {
    const n = Math.min(block, frames - done);
    core.render(main, n, null, so);
    for (let s = 0; s < nStems; s++) for (let i = 0; i < n; i++) stems[s].push(so[s][0][i]);
    for (let i = 0; i < n; i++) mainL.push(main[0][i]);
  }
  return { stems, mainL };
}

describe('LinkedWsola', () => {
  it('advances the source at the requested speed', () => {
    const len = SR * 10;
    const { core } = setup([rampStem('a', len)], len);
    core.setSpeed(0.5);
    core.play();
    render(core, SR * 4, 1);
    // 4 s of output at 0.5x covers ~2 s of source (within one grain + search window)
    expect(Math.abs(core.position.frame - SR * 2)).toBeLessThan(0.12 * SR);
    core.setSpeed(0.75);
    const before = core.position.frame;
    render(core, SR * 4, 1);
    expect(Math.abs(core.position.frame - before - SR * 3)).toBeLessThan(0.12 * SR);
  });

  it('splices every stem at the same offsets', () => {
    const len = SR * 6;
    const { core, wsola } = setup([offsetRampStem('a', len, 0), offsetRampStem('b', len, 1000)], len);
    wsola.logSplices = true;
    core.setSpeed(0.6);
    core.play();
    const { stems } = render(core, SR * 3, 2);
    expect(wsola.spliceLog.length).toBeGreaterThan(20);
    let checked = 0;
    for (let i = 1000; i < stems[0].length; i += 37) {
      const d = (decode(stems[1][i]) - decode(stems[0][i]) + PERIOD) % PERIOD;
      // outside the short overlap windows both stems read the same source frame
      if (Math.abs(d - 1000) <= 1) checked++;
    }
    expect(checked / Math.floor((stems[0].length - 1000) / 37)).toBeGreaterThan(0.8);
  });

  it('keeps pitch when slowing down', () => {
    const len = SR * 4;
    const { core } = setup([sineStem('a', len, 440)], len);
    core.setSpeed(0.5);
    core.play();
    const { mainL } = render(core, SR * 2, 1);
    const seg = mainL.slice(SR / 2, SR / 2 + SR); // one second, after the ramp
    let crossings = 0;
    for (let i = 1; i < seg.length; i++) if (seg[i - 1] < 0 && seg[i] >= 0) crossings++;
    expect(Math.abs(crossings - 440)).toBeLessThan(15);
  });

  it('returns to bit-exact playback at speed 1', () => {
    const len = SR * 6;
    const { core } = setup([rampStem('a', len)], len);
    core.setSpeed(0.7);
    core.play();
    render(core, SR, 1);
    core.setSpeed(1);
    render(core, SR, 1); // drains the buffered input
    const { stems } = render(core, 4096, 1);
    for (let i = 1; i < stems[0].length; i++) {
      expect((decode(stems[0][i]) - decode(stems[0][i - 1]) + PERIOD) % PERIOD).toBe(1);
    }
  });

  it('switching speed mid-play does not jump the position', () => {
    const len = SR * 6;
    const { core } = setup([rampStem('a', len)], len);
    core.play();
    render(core, SR, 1);
    const at = core.position.frame;
    core.setSpeed(0.8);
    const { stems } = render(core, 256, 1);
    expect(decode(stems[0][0])).toBe(at % PERIOD);
  });

  it('clicks once per beat when slowed down', () => {
    const len = SR * 8;
    const silent = stemFromFloat('z', [new Float32Array(len)]);
    const core = new RenderCore(SR);
    core.setSong({ id: 's', length: len, stems: [silent] }, {
      beats: [0, 12000, 24000, 36000, 48000, 60000],
      downbeats: [0, 48000],
    });
    core.setStretcher(new LinkedWsola(SR));
    core.setClick({ enabled: true, gain: 1 });
    core.setSpeed(0.5);
    core.seek(6000);
    core.play();
    const { mainL } = render(core, 100000, 1);
    // count click onsets (silence -> sound)
    let onsets = 0;
    let quiet = 1000;
    for (const v of mainL) {
      if (Math.abs(v) > 1e-4) {
        if (quiet > 500) onsets++;
        quiet = 0;
      } else quiet++;
    }
    // ~50000 source frames heard -> beats at 12000, 24000, 36000, 48000
    expect(onsets).toBe(4);
  });

  it('pausing while stretched resumes from what was heard', () => {
    const len = SR * 6;
    const { core } = setup([rampStem('a', len)], len);
    core.setSpeed(0.5);
    core.play();
    render(core, SR * 2, 1);
    const heard = core.position.frame;
    core.pause();
    render(core, 1024, 1);
    expect(core.isPlaying()).toBe(false);
    expect(Math.abs(core.position.frame - heard)).toBeLessThan(400);
  });
});
