import { describe, expect, it } from 'vitest';
import { LinkedWsola } from './LinkedWsola';
import { RenderCore } from './RenderCore';
import { stemFromFloat } from './StemBlocks';

const LEN = 48000;
const BAR = 4000; // downbeats every 4000 frames, beats every 1000
const BLOCK = 128;
// cue clips: constant levels so each word is easy to recognise on the cue channel
const CLIPS = [0.5, 0.25, 0.125].map((v) => new Float32Array(400).fill(v));
const GAIN = 0.8;

/**
 * Sections v (0-8000), c (8000-16000), b (16000-24000). Stem 0 ("guide") on
 * channel 2, stem 1 on channel 3, click on 0, cues on 1.
 */
function liveCore() {
  const core = new RenderCore();
  const dc = (id: string, v: number) => stemFromFloat(id, [new Float32Array(LEN).fill(v)], { silenceThreshold: 0 });
  core.setSong({ id: 's', length: LEN, stems: [dc('guide', 0.3), dc('band', 0.2)] }, {
    beats: Array.from({ length: 48 }, (_, i) => i * 1000),
    downbeats: Array.from({ length: 12 }, (_, i) => i * BAR),
  });
  core.setRouting({ stems: [[{ ch: 2 }], [{ ch: 3 }]], click: [0], cue: [1] });
  core.setProgram({
    segments: [
      { id: 'v', start: 0, end: 8000 },
      { id: 'c', start: 8000, end: 16000 },
      { id: 'b', start: 16000, end: 24000 },
    ],
    loop: false,
  });
  core.setCueClips(CLIPS);
  core.setCues({ enabled: true, segClip: [0, 1, 2], natural: true, guideStems: [0], gain: GAIN });
  return core;
}

/** Render `frames` from now; returns per-frame cue channel and guide channel output. */
function run(core: RenderCore, frames: number) {
  const o = Array.from({ length: 4 }, () => new Float32Array(BLOCK));
  const cue: number[] = [];
  const guide: number[] = [];
  for (let done = 0; done < frames; done += BLOCK) {
    core.render(o, BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      cue.push(o[1][i]);
      guide.push(o[2][i]);
    }
  }
  return { cue, guide };
}

/** [start frame, level] of each spoken word on the cue channel. */
function words(cue: number[], offset = 0) {
  const out: [number, number][] = [];
  for (let i = 0; i < cue.length; i++) {
    if (cue[i] !== 0 && (i === 0 || cue[i - 1] === 0)) out.push([offset + i, Math.round((cue[i] / GAIN) * 1000) / 1000]);
  }
  return out;
}

describe('spoken cues', () => {
  it('say each part one bar before it starts (song without a guide track)', () => {
    const core = liveCore();
    core.play();
    const { cue } = run(core, 20000);
    const w = words(cue);
    expect(w.map(([, v]) => v)).toEqual([0.25, 0.125]); // "c" then "b"
    expect(w[0][0]).toBeGreaterThanOrEqual(8000 - BAR);
    expect(w[0][0]).toBeLessThan(8000 - BAR + BLOCK);
    expect(w[1][0]).toBeGreaterThanOrEqual(16000 - BAR);
    expect(w[1][0]).toBeLessThan(16000 - BAR + BLOCK);
  });

  it('a queued jump announces its target instead', () => {
    const core = liveCore();
    core.play();
    run(core, 1024);
    core.queueJump(2, 'segmentEnd');
    const w = words(run(core, 8000).cue, 1024);
    expect(w).toHaveLength(1);
    expect(w[0][1]).toBe(0.125); // "b", not "c"
    expect(w[0][0]).toBeGreaterThanOrEqual(8000 - BAR);
  });

  it('with its own guide track, a song is only announced on jumps, and that guide is silenced until the jump lands', () => {
    const core = liveCore();
    core.setCues({ natural: false });
    core.play();
    // the song's own order: nothing said, the guide track plays throughout
    let r = run(core, 8064);
    expect(words(r.cue)).toEqual([]);
    expect(r.guide.slice(1000).every((v) => Math.abs(v - 0.3) < 1e-3)).toBe(true);
    // a jump from c (8000-16000) to v: said a bar before, guide silent from then until it lands
    core.queueJump(0, 'segmentEnd');
    r = run(core, 7936 + 2000);
    const w = words(r.cue, 8064);
    expect(w).toHaveLength(1);
    expect(w[0][1]).toBe(0.5);
    expect(w[0][0]).toBeGreaterThanOrEqual(16000 - BAR);
    const at = (f: number) => r.guide[f - 8064];
    expect(at(16000 - BAR - 200)).toBeCloseTo(0.3, 3); // before the cue: guide plays
    expect(at(16000 - BAR + 600)).toBe(0); // during the cue: silenced
    expect(at(16000 - 600)).toBe(0); // ...until the crossfade into the jump (the target's own lead-in) starts
    expect(core.position.segment).toBe(0); // landed
    expect(r.guide[r.guide.length - 1]).toBeCloseTo(0.3, 3); // and the guide is back
  });

  it('a tap in the last beat is too late to say anything; earlier in the last bar it is said at once', () => {
    let core = liveCore();
    core.setCues({ natural: false });
    core.play();
    run(core, 7552); // less than a beat (1000) before the end of v
    core.queueJump(2, 'segmentEnd');
    expect(words(run(core, 400).cue)).toEqual([]);

    core = liveCore();
    core.setCues({ natural: false });
    core.play();
    run(core, 6016); // 2 beats before the end
    core.queueJump(2, 'segmentEnd');
    const w = words(run(core, 400).cue, 6016);
    expect(w).toEqual([[6016, 0.125]]);
  });

  it('while repeating, the section is announced again before each time round', () => {
    const core = liveCore();
    core.setCues({ natural: false }); // even with a guide track: the guide would say the next part
    core.setRepeat(true);
    core.play();
    const w = words(run(core, 16000).cue);
    expect(w.map(([, v]) => v)).toEqual([0.5, 0.5]);
    expect(w[0][0]).toBeGreaterThanOrEqual(8000 - BAR);
    expect(w[1][0]).toBeGreaterThanOrEqual(16000 - BAR);
  });

  it('nothing is said when cues are off, and pausing stops a word', () => {
    const core = liveCore();
    core.setCues({ enabled: false });
    core.play();
    expect(words(run(core, 9000).cue)).toEqual([]);

    const c2 = liveCore();
    c2.play();
    run(c2, 4096 + 128); // the word has started
    c2.pause();
    const after = run(c2, 1024).cue;
    expect(after.slice(256).every((v) => v === 0)).toBe(true);
  });

  it('at a slower speed the word still comes a bar ahead in the music', () => {
    const core = liveCore();
    core.setStretcher(new LinkedWsola(48000));
    core.setSpeed(0.75);
    core.play();
    const o = Array.from({ length: 4 }, () => new Float32Array(BLOCK));
    let heardAtCue = -1;
    for (let b = 0; b < 200 && heardAtCue < 0; b++) {
      core.render(o, BLOCK);
      if (o[1].some((v) => v !== 0)) heardAtCue = core.position.frame;
    }
    // the cue starts when what is heard is a bar before the chorus (not the stretcher's read-ahead)
    expect(heardAtCue).toBeGreaterThan(8000 - BAR - 400);
    expect(heardAtCue).toBeLessThan(8000 - BAR + 400);
  });

  it('at a slower speed, a repeat coming round does not announce the next part early', () => {
    const core = liveCore();
    core.setStretcher(new LinkedWsola(48000));
    core.setSpeed(0.6);
    core.setCues({ natural: false });
    core.setRepeat(true);
    core.play();
    const o = Array.from({ length: 4 }, () => new Float32Array(BLOCK));
    const starts: number[] = [];
    let was = false;
    for (let b = 0; b < 600; b++) {
      core.render(o, BLOCK);
      const on = o[1].some((v) => v !== 0);
      if (on && !was) starts.push(core.position.frame);
      was = on;
    }
    // one word per time round, each about a bar before the end of the section (8000)
    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (const f of starts) {
      expect(f).toBeGreaterThan(8000 - BAR - 400);
      expect(f).toBeLessThan(8000 - BAR + 400);
    }
  });
});
