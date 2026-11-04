import { describe, expect, it } from 'vitest';
import { dbToGain, gainToDb } from './decibels';
import { RenderCore } from './RenderCore';
import { stemFromFloat } from './StemBlocks';
import { programLength, renderProgram } from '../export/render';

const SR = 48000;
const LEN = SR;
const dc = (id: string, v: number) => stemFromFloat(id, [new Float32Array(LEN).fill(v)], { silenceThreshold: 0 });

function settle(core: RenderCore, channels = 2): Float32Array[] {
  const o = Array.from({ length: channels }, () => new Float32Array(128));
  for (let i = 0; i < 12; i++) core.render(o, 128);
  return o;
}

describe('master level and song meter', () => {
  it('master scales every track on every output, but not the app click', () => {
    const core = new RenderCore(SR);
    core.setSong({ id: 's', length: LEN, stems: [dc('a', 0.4), dc('b', 0.2)] }, { beats: [], downbeats: [] });
    core.setRouting({ stems: [[{ ch: 2 }], [{ l: 4, r: 5 }]], click: [0] });
    core.play();
    core.setMasterGain(dbToGain(-6));
    const o = settle(core, 8);
    expect(o[2][100]).toBeCloseTo(0.4 * dbToGain(-6), 4);
    expect(o[4][100]).toBeCloseTo(0.2 * dbToGain(-6), 4);
    expect(o[5][100]).toBeCloseTo(0.2 * dbToGain(-6), 4);

    // the app's click is not part of the song
    const c = new RenderCore(SR);
    c.setSong({ id: 's', length: LEN, stems: [dc('z', 0)] }, { beats: [1000], downbeats: [1000] });
    c.setClick({ enabled: true, gain: 1 });
    c.setMasterGain(0);
    c.play();
    const out = [new Float32Array(2048), new Float32Array(2048)];
    c.render(out, 2048);
    expect(Math.max(...out[0].map(Math.abs))).toBeGreaterThan(0.5);
  });

  it('meters the summed song level and resets after reading', () => {
    const core = new RenderCore(SR);
    core.setSong({ id: 's', length: LEN, stems: [dc('a', 0.25), dc('b', 0.25)] });
    core.setRouting({ stems: [[{ ch: 2 }], [{ ch: 3 }]], click: [0] }); // even split across outputs
    core.play();
    settle(core, 8);
    core.takeMeter();
    settle(core, 8);
    const m = core.takeMeter();
    expect(m.l).toBeCloseTo(0.5, 4); // both tracks summed: -6 dBFS
    expect(gainToDb(m.r)).toBeCloseTo(-6.02, 1);
    expect(m.clip).toBe(false);
    expect(core.takeMeter().l).toBe(0); // reset
  });

  it('flags clipping on any output and reads 0 when stopped', () => {
    const core = new RenderCore(SR);
    core.setSong({ id: 's', length: LEN, stems: [dc('a', 0.6), dc('b', 0.6)] });
    core.play();
    settle(core);
    expect(core.takeMeter().clip).toBe(true); // 1.2 on channels 1-2
    core.setStem(1, { mute: true });
    settle(core);
    core.takeMeter();
    settle(core);
    expect(core.takeMeter().clip).toBe(false);
    core.pause();
    settle(core);
    core.takeMeter();
    settle(core);
    expect(core.takeMeter()).toEqual({ l: 0, r: 0, clip: false });
  });

  it('exports the mix at the song master level', () => {
    const make = (g: number) => {
      const core = new RenderCore(SR);
      core.setSong({ id: 's', length: LEN, stems: [dc('a', 0.5)] });
      core.setMasterGain(g);
      let peak = 0;
      const program = { segments: [{ id: 'x', start: 0, end: 24000 }], loop: false };
      const n = renderProgram(core, program, {
        speed: 1,
        onBlock: (main, _so, k) => {
          for (let i = 0; i < k; i++) peak = Math.max(peak, Math.abs(main[0][i]));
        },
      });
      expect(n).toBe(programLength(program));
      return peak;
    };
    expect(make(dbToGain(-12)) / make(1)).toBeCloseTo(dbToGain(-12), 3);
  });
});
