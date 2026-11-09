import { describe, expect, it } from 'vitest';
import { RenderCore } from './RenderCore';
import { buffers, decode, PERIOD, rampStem, song } from './testUtils';
import { XFADE_FRAMES, type CoreEvent } from './types';

/** Three contiguous 8000-frame sections, bars every 4000 frames, playing from the start. */
function liveCore() {
  const core = new RenderCore();
  const stems = [rampStem('a', 48000, 2), rampStem('b', 48000, 1)];
  core.setSong(song(stems, 48000), {
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
  const events: CoreEvent[] = [];
  core.onEvent = (e) => events.push(e);
  core.play();
  return { core, events };
}

function run(core: RenderCore, frames: number, block = 128) {
  const b = buffers(block, 2);
  const first: number[] = [];
  for (let done = 0; done < frames; done += block) {
    const n = Math.min(block, frames - done);
    core.render(b.main, n, b.stemOuts);
    for (let i = 0; i < n; i++) first.push(b.stemOuts[0][0][i]);
  }
  return first;
}

describe('Repeat (vamp)', () => {
  it('loops the current section at its end, again and again, with a tight crossfade', () => {
    const { core } = liveCore();
    run(core, 1000);
    core.setRepeat(true);
    expect(core.getRepeat()).toBe(true);
    run(core, 8000 - XFADE_FRAMES - 1000);
    expect(core.position.frame).toBe(8000 - XFADE_FRAMES);
    run(core, XFADE_FRAMES);
    expect(core.position.segment).toBe(0);
    expect(core.position.frame).toBe(0); // back at the section start, not into section 2
    // a few more times round
    for (let k = 0; k < 3; k++) {
      run(core, 8000);
      expect(core.position.segment).toBe(0);
      expect(core.position.frame).toBe(0);
    }
    const audio = run(core, 10);
    expect(decode(audio[0])).toBe(0);
  });

  it('a tapped section lands as usual and ends the repeat', () => {
    const { core, events } = liveCore();
    core.setRepeat(true);
    run(core, 9000); // once round: now at frame 1000 of section 1
    expect(core.position.segment).toBe(0);
    core.queueJump(2, 'segmentEnd');
    expect(events).toContainEqual({ type: 'armed', at: 8000, to: 2 });
    run(core, 7000);
    expect(core.position.segment).toBe(2);
    expect(core.position.frame).toBe(16000);
    expect(core.getRepeat()).toBe(false);
    expect(events).toContainEqual({ type: 'repeat', on: false });
    // and the new section plays on into the next one (no repeat)
    run(core, 8000);
    expect(core.position.frame).toBe(24000);
  });

  it('a jump at the next bar also lands mid-repeat', () => {
    const { core } = liveCore();
    core.setRepeat(true);
    run(core, 1000);
    core.queueJump(1, 'nextBar');
    run(core, 3000);
    expect(core.position.segment).toBe(1);
    expect(core.position.frame).toBe(8000);
    expect(core.getRepeat()).toBe(false);
  });

  it('turning repeat off lets the section carry on into the next one', () => {
    const { core } = liveCore();
    core.setRepeat(true);
    run(core, 4000);
    core.setRepeat(false);
    run(core, 4000);
    expect(core.position.segment).toBe(1);
    expect(core.position.frame).toBe(8000);
    const audio = run(core, 10);
    expect(decode(audio[0])).toBe(8000 % PERIOD);
  });

  it('repeats the last section instead of ending the song', () => {
    const { core, events } = liveCore();
    core.seek(20000);
    core.setRepeat(true);
    run(core, 4000 + 2000);
    expect(core.position.segment).toBe(2);
    expect(core.position.frame).toBe(18000);
    expect(events.some((e) => e.type === 'ended')).toBe(false);
  });

  it('a new song starts without repeat', () => {
    const { core } = liveCore();
    core.setRepeat(true);
    core.setSong(song([rampStem('x', 1000)], 1000));
    expect(core.getRepeat()).toBe(false);
  });
});
