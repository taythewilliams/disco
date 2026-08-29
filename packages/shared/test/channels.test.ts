import { describe, expect, it } from 'vitest';
import { channelColours, channelHue } from '../src/channels.js';
import { DEFAULT_CHANNEL_ID } from '../src/constants.js';

describe('channelHue', () => {
  it('pins the default channel', () => {
    // v1 ships one channel. It must not change colour if a second is ever
    // added ahead of it (D3).
    expect(channelHue(DEFAULT_CHANNEL_ID)).toBe(291);
  });

  it('is stable for a given id', () => {
    expect(channelHue('chill')).toBe(channelHue('chill'));
  });

  it('separates the channels a two-channel event would use', () => {
    expect(channelHue('main')).not.toBe(channelHue('chill'));
  });

  it('stays on the wheel', () => {
    for (const id of ['main', 'chill', 'a', 'b', 'room-2', 'zzzzzzzz']) {
      const hue = channelHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe('channelColours', () => {
  it('gives an accent and a dimmer wash from the same hue', () => {
    const { accent, wash } = channelColours('main');
    expect(accent).toBe('hsl(291 82% 68%)');
    expect(wash).toBe('hsl(291 46% 22%)');
  });
});
