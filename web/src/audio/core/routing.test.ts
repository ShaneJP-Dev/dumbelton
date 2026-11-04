import { describe, expect, it } from 'vitest';
import { RenderCore } from './RenderCore';
import { stemFromFloat } from './StemBlocks';

const SR = 48000;
const LEN = SR;
const dcStereo = (id: string, l: number, r: number) =>
  stemFromFloat(id, [new Float32Array(LEN).fill(l), new Float32Array(LEN).fill(r)], { silenceThreshold: 0 });
const dcMono = (id: string, v: number) => stemFromFloat(id, [new Float32Array(LEN).fill(v)], { silenceThreshold: 0 });

function outs(n: number, frames = 128) {
  return Array.from({ length: n }, () => new Float32Array(frames));
}

/** Play past the 5 ms ramps, then return one settled block. */
function settled(core: RenderCore, channels: number): Float32Array[] {
  const o = outs(channels);
  for (let i = 0; i < 6; i++) core.render(o, 128);
  return o;
}

describe('output routing', () => {
  it('sends each stem to its own channels; stereo stems are summed for a mono channel', () => {
    const core = new RenderCore(SR);
    core.setSong({ id: 's', length: LEN, stems: [dcStereo('keys', 0.2, 0.4), dcMono('bass', 0.3)] });
    core.setRouting({ stems: [[{ l: 5, r: 6 }], [{ ch: 4 }]], click: [0] });
    core.play();
    const o = settled(core, 16);
    expect(o[5][100]).toBeCloseTo(0.2, 4); // keys L
    expect(o[6][100]).toBeCloseTo(0.4, 4); // keys R
    expect(o[4][100]).toBeCloseTo(0.3, 4); // bass (mono stays at full level)
    for (const c of [0, 1, 2, 3, 7, 15]) expect(o[c].every((v) => v === 0)).toBe(true);
    // a stereo stem on a single channel is summed to mono
    core.setRouting({ stems: [[{ ch: 9 }], [{ ch: 4 }]], click: [0] });
    const o2 = settled(core, 16);
    expect(o2[9][100]).toBeCloseTo(0.3, 4);
  });

  it('a stem can feed its own channel and a stereo mix pair', () => {
    const core = new RenderCore(SR);
    core.setSong({ id: 's', length: LEN, stems: [dcMono('drums', 0.25), dcMono('bass', 0.25)] });
    core.setRouting({ stems: [[{ ch: 2 }, { l: 14, r: 15 }], [{ ch: 4 }, { l: 14, r: 15 }]], click: [0] });
    core.play();
    const o = settled(core, 16);
    expect(o[2][100]).toBeCloseTo(0.25, 4);
    expect(o[4][100]).toBeCloseTo(0.25, 4);
    expect(o[14][100]).toBeCloseTo(0.5, 4);
    expect(o[15][100]).toBeCloseTo(0.5, 4);
  });

  it('volume, mute and solo apply on every output', () => {
    const core = new RenderCore(SR);
    core.setSong({ id: 's', length: LEN, stems: [dcMono('a', 0.5), dcMono('b', 0.5)] });
    core.setRouting({ stems: [[{ ch: 2 }], [{ ch: 3 }]], click: [0] });
    core.play();
    core.setStem(0, { gain: 0.5 });
    core.setStem(1, { mute: true });
    const o = settled(core, 8);
    expect(o[2][100]).toBeCloseTo(0.25, 4);
    expect(o[3][100]).toBe(0);
    core.setStem(1, { mute: false, solo: true });
    const o2 = settled(core, 8);
    expect(o2[2][100]).toBe(0);
    expect(o2[3][100]).toBeCloseTo(0.5, 4);
  });

  it('puts the click and the count-in only on the click channel', () => {
    const core = new RenderCore(SR);
    core.setSong({ id: 's', length: LEN, stems: [dcMono('a', 0.1)] }, { beats: [1000, 2000], downbeats: [1000] });
    core.setRouting({ stems: [[{ ch: 3 }]], click: [0] });
    core.setClick({ enabled: true, gain: 1 });
    core.play();
    const o = outs(8, 2048);
    core.render(o, 2048);
    expect(o[0].slice(1001, 1100).some((v) => v !== 0)).toBe(true); // click on channel 1
    expect(o[1].every((v) => v === 0)).toBe(true);
    expect(o[3][1500]).toBeCloseTo(0.1, 4); // music on its own channel, no click mixed in
    // count-in
    const c2 = new RenderCore(SR);
    c2.setSong({ id: 's', length: LEN, stems: [dcMono('a', 0.1)] }, { beats: [0, 12000], downbeats: [0, 48000] });
    c2.setRouting({ stems: [[{ ch: 3 }]], click: [1] });
    c2.play({ countIn: true });
    const o3 = outs(8, 1024);
    c2.render(o3, 1024);
    expect(o3[1].some((v) => v !== 0)).toBe(true);
    expect(o3[3].every((v) => v === 0)).toBe(true);
  });

  it('fades every channel in on play', () => {
    const core = new RenderCore(SR);
    core.setSong({ id: 's', length: LEN, stems: [dcMono('a', 0.5)] });
    core.setRouting({ stems: [[{ ch: 7 }]], click: [0] });
    core.play();
    const o = outs(8);
    core.render(o, 128);
    expect(o[7][0]).toBeLessThan(0.01);
    expect(o[7][127]).toBeGreaterThan(0.1);
  });

  it('ignores channels the device does not have', () => {
    const core = new RenderCore(SR);
    core.setSong({ id: 's', length: LEN, stems: [dcMono('a', 0.5)] });
    core.setRouting({ stems: [[{ ch: 20 }, { ch: 1 }]], click: [30] });
    core.play();
    const o = settled(core, 2);
    expect(o[1][100]).toBeCloseTo(0.5, 4);
    expect(o[0][100]).toBe(0);
  });

  it('plays a test tone on one channel, even when stopped and with no song', () => {
    const core = new RenderCore(SR);
    core.testTone(5);
    const o = outs(8, 4096);
    core.render(o, 4096);
    expect(Math.max(...o[5].map(Math.abs))).toBeGreaterThan(0.2);
    for (const c of [0, 1, 4, 6]) expect(o[c].every((v) => v === 0)).toBe(true);
    // stops after ~0.6 s
    for (let i = 0; i < 10; i++) core.render(o, 4096);
    expect(o[5].every((v) => v === 0)).toBe(true);
  });

  it('defaults to stereo on channels 1-2', () => {
    const core = new RenderCore(SR);
    core.setSong({ id: 's', length: LEN, stems: [dcStereo('a', 0.2, 0.3)] });
    core.play();
    const o = settled(core, 4);
    expect(o[0][100]).toBeCloseTo(0.2, 4);
    expect(o[1][100]).toBeCloseTo(0.3, 4);
    expect(o[2][100]).toBe(0);
  });
});
