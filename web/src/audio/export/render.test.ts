import { describe, expect, it } from 'vitest';
import { LinkedWsola } from '../core/LinkedWsola';
import { RenderCore } from '../core/RenderCore';
import { decode, rampStem } from '../core/testUtils';
import { programLength, renderProgram } from './render';

function core(len: number) {
  const c = new RenderCore(48000);
  c.setSong({ id: 's', length: len, stems: [rampStem('a', len), rampStem('b', len, 1)] });
  c.setStretcher(new LinkedWsola(48000));
  return c;
}

const program = {
  segments: [
    { id: 'c', start: 96000, end: 192000 },
    { id: 'v', start: 0, end: 96000 },
    { id: 'c2', start: 96000, end: 192000 },
  ],
  loop: false,
};

describe('renderProgram', () => {
  it('exports exactly the sum of the section lengths at 1x', () => {
    const c = core(300000);
    const chunks: number[] = [];
    let firstStem: number | null = null;
    const n = renderProgram(c, program, {
      speed: 1,
      stems: 2,
      onBlock: (_m, so, k) => {
        if (firstStem === null && so) firstStem = decode(so[0][0][0]);
        chunks.push(k);
      },
    });
    expect(n).toBe(programLength(program));
    expect(chunks.reduce((a, b) => a + b, 0)).toBe(288000);
    expect(firstStem).toBe(96000 % 4096);
  });

  it('exports about length / speed when slowed down', () => {
    const c = core(300000);
    c.setSpeed(0.75);
    const n = renderProgram(c, program, { speed: 0.75, onBlock: () => undefined });
    expect(Math.abs(n - 288000 / 0.75)).toBeLessThan(48000 * 0.15);
  });
});
