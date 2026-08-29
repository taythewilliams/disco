/**
 * Channel identity (D3).
 *
 * The colour-coded-headset equivalent: each channel owns a hue, and every
 * surface that shows a channel — the projector's now-playing card, the
 * dashboard, and eventually the whole guest UI — reads it from here. One
 * definition, so a channel is the same colour on the projector as it is in
 * someone's hand.
 *
 * Derived from the ID rather than configured, so adding a channel is a config
 * change and not also a palette decision. `main` is pinned: v1 ships one channel
 * and it should not change colour if a second is ever added ahead of it.
 */

import { DEFAULT_CHANNEL_ID } from './constants.js';

/** Fixed hues, spaced far enough apart to be told apart across a dark room. */
const PINNED: Record<string, number> = { [DEFAULT_CHANNEL_ID]: 291 };

/** Steps around the wheel that avoid landing next to `main`'s violet. */
const HUES = [291, 174, 39, 210, 96, 330, 15, 255];

/** A stable hue in [0, 360) for a channel ID. */
export function channelHue(channelId: string): number {
  const pinned = PINNED[channelId];
  if (pinned !== undefined) return pinned;

  // FNV-1a. Any stable hash would do; this one is four lines and has no
  // dependency, which matters in a package both bundles import.
  let hash = 0x811c9dc5;
  for (let i = 0; i < channelId.length; i++) {
    hash ^= channelId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return HUES[hash % HUES.length] as number;
}

export interface ChannelColours {
  /** Saturated, for text and strokes on a dark background. */
  accent: string;
  /** Dimmed, for fills that must not compete with the text over them. */
  wash: string;
}

/**
 * Colours for a channel.
 *
 * Lightness is fixed high and saturation moderate: the projector is a bright
 * surface in a dark room, and a fully saturated fill at that size is unpleasant
 * to stand in front of for three hours.
 */
export function channelColours(channelId: string): ChannelColours {
  const hue = channelHue(channelId);
  return {
    accent: `hsl(${hue} 82% 68%)`,
    wash: `hsl(${hue} 46% 22%)`,
  };
}
