import { describe, expect, it } from 'vitest';
import { detectCapabilities, selectEngine } from '../src/engine/select.js';

describe('engine selection', () => {
  const caps = (over: Partial<ReturnType<typeof detectCapabilities>> = {}) => ({
    webAudio: true,
    mediaElement: true,
    iOS: false,
    ...over,
  });

  it('prefers Web Audio for its scheduling precision', () => {
    // 5–10 ms against 30–50 ms is a real difference in a 35–80 ms budget.
    expect(selectEngine(caps())).toBe('webaudio');
  });

  it('falls back when Web Audio is unavailable', () => {
    expect(selectEngine(caps({ webAudio: false }))).toBe('mediaelement');
  });

  it('honours a server-driven override', () => {
    // The decision to drop an engine should be made on telemetry from a real
    // floor, so until then it has to be changeable without a redeploy (D11).
    expect(selectEngine(caps(), 'mediaelement')).toBe('mediaelement');
    expect(selectEngine(caps(), 'webaudio')).toBe('webaudio');
  });

  it('ignores an override for an engine the device cannot run', () => {
    // A config that silently selects an unsupported engine is worse than none.
    expect(selectEngine(caps({ mediaElement: false }), 'mediaelement')).toBe('webaudio');
  });

  it('returns null when neither engine is available', () => {
    expect(selectEngine(caps({ webAudio: false, mediaElement: false }))).toBeNull();
  });
});
