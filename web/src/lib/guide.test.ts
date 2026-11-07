import { describe, expect, it } from 'vitest';
import { guideMessage, guideStems, type GuideResult } from './guide';
import { defaultSetup } from './outputs';
import type { Stem } from './types';

const stem = (id: string, name: string, output?: string) => ({ id, name, output }) as unknown as Stem;

describe('guideStems', () => {
  const setup = defaultSetup();

  it('uses the Outputs Guide group (guide, cue, cues) and pinned outputs', () => {
    const stems = [stem('a', 'Drums'), stem('b', 'Guide'), stem('c', 'Cues ES'), stem('d', 'Voice notes', 'guide'), stem('e', 'Click')];
    expect(guideStems(stems, setup).map((s) => s.id)).toEqual(['b', 'c', 'd']);
  });

  it('falls back to a track named like a guide when the Click group took it', () => {
    expect(guideStems([stem('a', 'Click + Guide'), stem('b', 'Bass')], setup).map((s) => s.id)).toEqual(['a']);
  });

  it('follows keyword edits on the Outputs screen', () => {
    const custom = defaultSetup();
    custom.groups.find((g) => g.id === 'guide')!.keywords.push('talk');
    expect(guideStems([stem('a', 'Talkback'), stem('b', 'Bass')], custom).map((s) => s.id)).toEqual(['a']);
  });

  it('is empty when there is no guide track', () => {
    expect(guideStems([stem('a', 'Drums'), stem('b', 'Click')], setup)).toEqual([]);
  });
});

describe('guideMessage', () => {
  const cues = [
    { time: 6, end: 6.4, kind: 'verse', word: 'verso', conf: 1 },
    { time: 22, end: 22.4, kind: 'chorus', word: 'coro', conf: 1 },
  ];
  const g = (over: Partial<GuideResult>): GuideResult => ({ status: 'ok', cues, ...over });

  it('says when sections came from the cues, and in which language', () => {
    expect(guideMessage(g({ language: 'es' }), 'guide')).toEqual({
      text: "Sections placed from the guide track's spoken cues (2 cues, Spanish).",
      kind: 'info',
    });
  });

  it('explains a fallback to the audio', () => {
    expect(guideMessage(g({ status: 'unavailable', message: "speech models aren't downloaded yet. Run `pnpm models` once with internet (English: offline)" }), 'audio')?.text).toBe(
      "Couldn't read the guide track: speech models aren't downloaded yet. Run `pnpm models` once with internet. Sections came from the audio instead.",
    );
    expect(guideMessage(g({ status: 'few-cues', cues: [] }), 'audio')?.text).toMatch(/fewer than two section cues/);
    expect(guideMessage(g({ status: 'error', message: 'RuntimeError: bad model' }), 'audio')).toEqual({
      text: "Couldn't read the guide track (RuntimeError: bad model). Sections came from the audio instead.",
      kind: 'error',
    });
  });

  it('says nothing without a guide track or when transcription is off', () => {
    expect(guideMessage(undefined, 'audio')).toBeNull();
    expect(guideMessage(g({ status: 'off' }), 'audio')).toBeNull();
  });
});
