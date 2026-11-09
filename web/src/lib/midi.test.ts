import { describe, expect, it } from 'vitest';
import { actionFor, assign, describeTrigger, midiActions, parseMidi, type MidiMap } from './midi';

describe('parseMidi', () => {
  it('reads notes, note-offs and velocity-0 note-ons', () => {
    expect(parseMidi([0x90, 60, 100])).toEqual({ kind: 'note', channel: 1, number: 60, press: true, hasRelease: true });
    expect(parseMidi([0x80, 60, 0])).toMatchObject({ kind: 'note', number: 60, press: false });
    expect(parseMidi([0x93, 36, 0])).toMatchObject({ kind: 'note', channel: 4, number: 36, press: false });
  });

  it('reads control changes as pressed at 64 and above', () => {
    expect(parseMidi([0xb0, 64, 127])).toMatchObject({ kind: 'cc', number: 64, press: true });
    expect(parseMidi([0xb0, 64, 0])).toMatchObject({ kind: 'cc', number: 64, press: false });
    expect(parseMidi([0xbf, 80, 63])).toMatchObject({ kind: 'cc', channel: 16, press: false });
  });

  it('reads program changes as presses without a release', () => {
    expect(parseMidi([0xc0, 2])).toEqual({ kind: 'pc', channel: 1, number: 2, press: true, hasRelease: false });
  });

  it('ignores everything else (clock, pitch bend, sysex)', () => {
    expect(parseMidi([0xf8])).toBeNull();
    expect(parseMidi([0xe0, 0, 64])).toBeNull();
    expect(parseMidi([0xf0, 1, 2, 0xf7])).toBeNull();
  });
});

describe('mapping', () => {
  const cc64 = { kind: 'cc' as const, channel: 1, number: 64 };
  const c4 = { kind: 'note' as const, channel: 1, number: 60 };

  it('assigns a trigger to one action only', () => {
    let map: MidiMap = {};
    map = assign(map, 'next-section', cc64);
    map = assign(map, 'mute-all', c4);
    expect(actionFor(map, { ...cc64 })).toBe('next-section');
    // learning the same pedal for another action moves it
    map = assign(map, 'repeat', cc64);
    expect(actionFor(map, cc64)).toBe('repeat');
    expect(map['next-section']).toBeUndefined();
    // a new pedal for an action replaces its old one
    map = assign(map, 'mute-all', { kind: 'pc', channel: 1, number: 0 });
    expect(actionFor(map, c4)).toBeNull();
    // channels and kinds are told apart
    expect(actionFor(map, { ...cc64, channel: 2 })).toBeNull();
    expect(actionFor(map, { kind: 'note', channel: 1, number: 64 })).toBeNull();
  });

  it('describes triggers in musicians’ terms', () => {
    expect(describeTrigger(c4)).toBe('Note C4 · ch 1');
    expect(describeTrigger(cc64)).toBe('CC 64 · ch 1');
    expect(describeTrigger({ kind: 'pc', channel: 10, number: 0 })).toBe('Program 1 · ch 10');
  });

  it('lists group mutes from the Outputs groups', () => {
    const ids = midiActions([{ id: 'drums', name: 'Drums' }]).map((a) => a.id);
    expect(ids).toContain('section-8');
    expect(ids).toContain('group:drums');
    expect(ids[0]).toBe('play');
  });
});
