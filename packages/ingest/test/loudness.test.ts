import { describe, expect, it } from 'vitest';
import { gainForTarget } from '../src/loudness.js';
import type { LoudnessResult } from '../src/types.js';

const measured = (integratedLufs: number, truePeakDb: number): LoudnessResult => ({
  integratedLufs,
  truePeakDb,
  loudnessRange: 6,
});

describe('gainForTarget', () => {
  it('is a no-op for a track already at target', () => {
    expect(gainForTarget(measured(-14, -3))).toBe(0);
  });

  it('attenuates a loud master', () => {
    // A modern −8 LUFS master comes down 6 dB. Attenuation is always safe.
    expect(gainForTarget(measured(-8, -0.5))).toBe(-6);
  });

  it('boosts a quiet master when there is headroom', () => {
    expect(gainForTarget(measured(-20, -12))).toBe(6);
  });

  it('backs the gain off rather than clipping', () => {
    // Wants +6 dB, but the peak is already at −2 dBTP, so only 1 dB fits under
    // the ceiling. This is the case normalisation would otherwise break: quiet,
    // dynamic masters are exactly the ones that want the most gain.
    expect(gainForTarget(measured(-20, -2))).toBe(1);
  });

  it('attenuates a track whose peak is already over the ceiling', () => {
    expect(gainForTarget(measured(-16, 4.68))).toBe(-5.68);
  });

  it('caps the boost however quiet the source', () => {
    expect(gainForTarget(measured(-45, -40))).toBe(12);
  });

  it('honours an overridden target and ceiling', () => {
    expect(gainForTarget(measured(-20, -30), -16)).toBe(4);
    expect(gainForTarget(measured(-20, -2), -14, -6)).toBe(-4);
  });

  it('rounds to a hundredth of a dB', () => {
    const gain = gainForTarget(measured(-17.123456, -20));
    expect(gain).toBe(3.12);
  });
});
