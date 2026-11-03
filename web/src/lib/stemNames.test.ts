import { describe, expect, it } from 'vitest';
import { isGuideStem, songNameFromFiles, stemColor, stemNamesFromFiles } from './stemNames';

describe('stem names', () => {
  it('strips the shared prefix at a separator', () => {
    expect(stemNamesFromFiles(['Way Maker - Drums.wav', 'Way Maker - Bass.wav', 'Way Maker - Click.wav'])).toEqual([
      'Drums',
      'Bass',
      'Click',
    ]);
    expect(stemNamesFromFiles(['bass.wav', 'bells.wav'])).toEqual(['bass', 'bells']);
    expect(songNameFromFiles(['Way Maker - Drums.wav', 'Way Maker - Bass.wav'])).toBe('Way Maker');
  });

  it('recognises guide stems and colours', () => {
    expect(isGuideStem('Click')).toBe(true);
    expect(isGuideStem('Guide Vocal')).toBe(true);
    expect(isGuideStem('Lead Vocal')).toBe(false);
    expect(stemColor('Kick', 0)).toBe('#ef4444');
  });
});
