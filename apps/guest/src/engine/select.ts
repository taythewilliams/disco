/**
 * Engine selection (D2).
 *
 * Capability detection first, then a server-driven override so one engine can
 * be forced across the whole room from the dashboard mid-event. The override
 * exists because the decision to drop an engine should be made on telemetry
 * from a real floor, and until then it must be changeable without a redeploy
 * (D11).
 */

import type { EngineOverride } from '@disco/shared';
import { mediaElementSupported } from './mediaelement.js';

export interface Capabilities {
  webAudio: boolean;
  mediaElement: boolean;
  /** iOS suspends an AudioContext when backgrounded, which biases the default. */
  iOS: boolean;
}

export function detectCapabilities(scope: typeof globalThis = globalThis): Capabilities {
  const g = scope as {
    AudioContext?: unknown;
    webkitAudioContext?: unknown;
    navigator?: { userAgent?: string; maxTouchPoints?: number };
  };
  const ua = g.navigator?.userAgent ?? '';
  return {
    webAudio: typeof g.AudioContext !== 'undefined' || typeof g.webkitAudioContext !== 'undefined',
    mediaElement: mediaElementSupported(),
    // iPadOS reports a desktop user agent, so the touch-point check is what
    // catches it.
    iOS: /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (g.navigator?.maxTouchPoints ?? 0) > 1),
  };
}

export type EngineName = 'webaudio' | 'mediaelement';

/**
 * Pick an engine.
 *
 * Web Audio by default: its 5–10 ms scheduling precision against a media
 * element's 30–50 ms is a real difference in a 35–80 ms budget. The override
 * wins whenever the forced engine is actually supported — a config that
 * silently selects an engine the device cannot run is worse than no config.
 */
export function selectEngine(caps: Capabilities, override: EngineOverride = 'auto'): EngineName | null {
  if (override === 'webaudio' && caps.webAudio) return 'webaudio';
  if (override === 'mediaelement' && caps.mediaElement) return 'mediaelement';

  if (caps.webAudio) return 'webaudio';
  if (caps.mediaElement) return 'mediaelement';
  return null;
}
