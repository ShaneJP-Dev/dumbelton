import { describe, expect, it } from 'vitest';
import { commonFolder, isAudioFile, skippedMessage, sortFiles } from './audioFiles';

const f = (name: string, type = '') => ({ name, type });

describe('audio file filtering', () => {
  it('keeps m4a stems and skips their Ableton .asd files', () => {
    const files = [f('Drums.m4a', 'audio/x-m4a'), f('Drums.m4a.asd'), f('Bass.m4a', 'audio/mp4'), f('Bass.m4a.asd')];
    const s = sortFiles(files);
    expect(s.audio.map((x) => x.name)).toEqual(['Bass.m4a', 'Drums.m4a']);
    expect(s.asd).toBe(2);
    expect(skippedMessage(s)).toBe('Skipped 2 Ableton .asd files (analysis data, not audio).');
  });

  it('skips macOS metadata, project files and hidden files', () => {
    expect(isAudioFile(f('._Drums.m4a'))).toBe(false);
    expect(isAudioFile(f('.DS_Store'))).toBe(false);
    expect(isAudioFile(f('Song.als'))).toBe(false);
    expect(isAudioFile(f('Vocals.WAV'))).toBe(true);
    expect(isAudioFile(f('Pad.aif'))).toBe(true);
    expect(isAudioFile(f('track', 'audio/wav'))).toBe(true);
    const s = sortFiles([f('Keys.wav'), f('Song.als'), f('._Keys.wav'), f('notes.txt')]);
    expect(s.audio.map((x) => x.name)).toEqual(['Keys.wav']);
    expect(skippedMessage(s)).toBe('Skipped 2 other files.');
  });

  it('explains when only .asd files were chosen', () => {
    const s = sortFiles([f('Drums.m4a.asd'), f('Bass.m4a.asd')]);
    expect(s.audio).toEqual([]);
    expect(skippedMessage(s)).toMatch(/choose the audio files next to them/);
  });

  it('orders stems naturally and finds the picked folder', () => {
    expect(sortFiles([f('Track 10.m4a'), f('Track 2.m4a'), f('Track 1.m4a')]).audio.map((x) => x.name)).toEqual([
      'Track 1.m4a',
      'Track 2.m4a',
      'Track 10.m4a',
    ]);
    expect(commonFolder([{ webkitRelativePath: 'Way Maker/Drums.m4a' }, { webkitRelativePath: 'Way Maker/x/Bass.m4a' }])).toBe(
      'Way Maker',
    );
    expect(commonFolder([{ webkitRelativePath: '' }])).toBeNull();
  });
});
