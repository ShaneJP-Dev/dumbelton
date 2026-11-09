import { describe, expect, it } from 'vitest';
import { RenderCore } from './RenderCore';
import { stemFromFloat } from './StemBlocks';

const SR = 48000;
const LEN = SR;
const dcMono = (id: string, v: number) => stemFromFloat(id, [new Float32Array(LEN).fill(v)], { silenceThreshold: 0 });
const dcStereo = (id: string, l: number, r: number) =>
  stemFromFloat(id, [new Float32Array(LEN).fill(l), new Float32Array(LEN).fill(r)], { silenceThreshold: 0 });

/** Guide on channel 2 (index 1), bass on 5 (4), keys on 6-7 (5-6): like the church layout. */
function deskCore() {
  const core = new RenderCore(SR);
  core.setSong({ id: 's', length: LEN, stems: [dcMono('guide', 0.1), dcMono('bass', 0.3), dcStereo('keys', 0.2, 0.4)] });
  core.setRouting({ stems: [[{ ch: 1 }], [{ ch: 4 }], [{ l: 5, r: 6 }]], click: [0], cue: [1] });
  core.play();
  return core;
}

function settle(core: RenderCore, blocks = 8): Float32Array[] {
  const o = Array.from({ length: 8 }, () => new Float32Array(128));
  for (let i = 0; i < blocks; i++) core.render(o, 128);
  return o;
}

describe('desk meters and the laptop monitor', () => {
  it('meters every output channel', () => {
    const core = deskCore();
    settle(core);
    const p = core.takeChannelPeaks();
    expect(p[0]).toBe(0); // click off
    expect(p[1]).toBeCloseTo(0.1, 3);
    expect(p[4]).toBeCloseTo(0.3, 3);
    expect(p[5]).toBeCloseTo(0.2, 3);
    expect(p[6]).toBeCloseTo(0.4, 3);
    expect(p[7]).toBe(0);
    expect(core.takeChannelPeaks()[4]).toBe(0); // reset after reading
  });

  it('without a monitor, outputs 1-2 carry their own channels', () => {
    const core = deskCore();
    const o = settle(core);
    expect(o[0][100]).toBe(0);
    expect(o[1][100]).toBeCloseTo(0.1, 3);
  });

  it('the mix monitor puts the full stereo mix on 1-2, while the meters still show the real channels', () => {
    const core = deskCore();
    core.setMonitor({ kind: 'mix' });
    const o = settle(core);
    // L: guide 0.1 + bass 0.3 + keys L 0.2; R: 0.1 + 0.3 + 0.4
    expect(o[0][100]).toBeCloseTo(0.6, 3);
    expect(o[1][100]).toBeCloseTo(0.8, 3);
    expect(o[4][100]).toBeCloseTo(0.3, 3); // the other channels are untouched
    const p = core.takeChannelPeaks();
    expect(p[0]).toBe(0);
    expect(p[1]).toBeCloseTo(0.1, 3);
  });

  it('the mix monitor includes the app click', () => {
    const core = deskCore();
    core.setGrid({ beats: Array.from({ length: 10 }, (_, i) => 3000 + i * 4000), downbeats: [3000] });
    core.setClick({ enabled: true, gain: 1 });
    core.setMonitor({ kind: 'mix' });
    settle(core, 16); // past the play fade-in: frames 0-2047
    const o = Array.from({ length: 8 }, () => new Float32Array(2048));
    core.render(o, 2048); // frames 2048-4095, the click at 3000
    const off = (from: number, to: number) => Array.from(o[0].subarray(from, to)).some((v) => Math.abs(v - 0.6) > 0.05);
    expect(off(0, 900)).toBe(false); // just the mix before the beat
    expect(off(952, 1200)).toBe(true); // the click on the beat
  });

  it('listening to one channel plays it on both sides', () => {
    const core = deskCore();
    core.setMonitor({ kind: 'channel', ch: 6 });
    let o = settle(core);
    expect(o[0][100]).toBeCloseTo(0.4, 3);
    expect(o[1][100]).toBeCloseTo(0.4, 3);
    // channel 2 itself (index 1) can be listened to as well
    core.setMonitor({ kind: 'channel', ch: 1 });
    o = settle(core, 2);
    expect(o[0][100]).toBeCloseTo(0.1, 3);
    expect(o[1][100]).toBeCloseTo(0.1, 3);
    core.setMonitor(null);
    o = settle(core, 2);
    expect(o[0][100]).toBe(0);
  });
});
