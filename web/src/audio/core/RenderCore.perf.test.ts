import { describe, expect, it } from 'vitest';
import { LinkedWsola } from './LinkedWsola';
import { RenderCore } from './RenderCore';
import { stemFromFloat } from './StemBlocks';

const SR = 48000;

function noiseStem(id: string, seconds: number) {
  const n = SR * seconds;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = Math.sin(i * 0.01) * 0.3 + (Math.random() - 0.5) * 0.1;
    r[i] = Math.sin(i * 0.013) * 0.3 + (Math.random() - 0.5) * 0.1;
  }
  return stemFromFloat(id, [l, r]);
}

function speedFactor(speed: number, stems = 12, seconds = 20, outputs = 2): number {
  const core = new RenderCore(SR);
  const list = Array.from({ length: stems }, (_, i) => noiseStem(`s${i}`, seconds));
  core.setSong({ id: 's', length: SR * seconds, stems: list });
  core.setStretcher(new LinkedWsola(SR));
  core.setSpeed(speed);
  if (outputs > 2) {
    // every stem on its own stereo pair, like a multitrack Dante setup
    core.setRouting({ stems: list.map((_, i) => [{ l: (2 * i) % outputs, r: (2 * i + 1) % outputs }]), click: [0] });
  }
  core.play();
  const main = Array.from({ length: outputs }, () => new Float32Array(128));
  const frames = SR * 10;
  // warm up the JIT
  for (let i = 0; i < 200; i++) core.render(main, 128);
  const t0 = performance.now();
  for (let done = 0; done < frames; done += 128) core.render(main, 128);
  const ms = performance.now() - t0;
  return frames / SR / (ms / 1000);
}

describe('performance gate', () => {
  it('12 stereo stems render >= 40x real time at 1.0x, 0.5x and on 32 outputs', () => {
    const at1 = speedFactor(1);
    const at05 = speedFactor(0.5);
    const multi = speedFactor(1, 12, 20, 32);
    console.log(`realtime factor: 1.0x -> ${at1.toFixed(0)}x, 0.5x -> ${at05.toFixed(0)}x, 32 outputs -> ${multi.toFixed(0)}x`);
    expect(at1).toBeGreaterThan(40);
    expect(at05).toBeGreaterThan(40);
    expect(multi).toBeGreaterThan(40);
  });
});
