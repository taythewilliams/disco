import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_MAX_MS,
  CALIBRATION_MIN_MS,
  STORAGE_KEY,
  clampCalibration,
  clearCalibration,
  loadCalibration,
  quantiseCalibration,
  resolveCalibration,
  saveCalibration,
  seedFromOutputLatency,
  shouldSuggestRecalibration,
  type Calibration,
  type CalibrationStorage,
} from '../src/calibration.js';

const PRESETS = {
  wired: 0,
  airpods: 160,
  bluetooth: 200,
  'bluetooth-lowlatency': 80,
  generic: 100,
};

const NOW = 1_724_832_000_000;

class MemoryStorage implements CalibrationStorage {
  readonly map = new Map<string, string>();
  throwOnAccess = false;

  getItem(key: string): string | null {
    if (this.throwOnAccess) throw new Error('blocked');
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnAccess) throw new Error('blocked');
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    if (this.throwOnAccess) throw new Error('blocked');
    this.map.delete(key);
  }
}

describe('clamping and quantising', () => {
  it('keeps values inside the slider range', () => {
    expect(clampCalibration(-500)).toBe(CALIBRATION_MIN_MS);
    expect(clampCalibration(5_000)).toBe(CALIBRATION_MAX_MS);
    expect(clampCalibration(180)).toBe(180);
  });

  it('treats a non-finite value as zero rather than propagating NaN', () => {
    // A NaN offset would silently schedule every track at NaN.
    expect(clampCalibration(NaN)).toBe(0);
    expect(clampCalibration(Infinity)).toBe(CALIBRATION_MAX_MS);
  });

  it('snaps to the slider step so stored and displayed values agree', () => {
    expect(quantiseCalibration(182)).toBe(180);
    expect(quantiseCalibration(183)).toBe(185);
    expect(quantiseCalibration(-3)).toBe(-5);
  });
});

describe('seedFromOutputLatency', () => {
  it('converts a plausible reading to milliseconds', () => {
    expect(seedFromOutputLatency(0.18)).toBe(180);
    expect(seedFromOutputLatency(0.042)).toBe(40);
  });

  it('discards the readings browsers actually give you', () => {
    // Zero, absent, and absurd are all common. A 4-second seed would put a
    // guest a bar behind the room before they touched anything (D1).
    expect(seedFromOutputLatency(0)).toBeNull();
    expect(seedFromOutputLatency(undefined)).toBeNull();
    expect(seedFromOutputLatency(NaN)).toBeNull();
    expect(seedFromOutputLatency(-0.05)).toBeNull();
    expect(seedFromOutputLatency(4)).toBeNull();
  });
});

describe('resolveCalibration', () => {
  const base = { stored: null, outputLatencySec: undefined, presetKey: null, presets: PRESETS, now: NOW };

  it('falls back to the generic preset rather than to zero', () => {
    // No real device has zero output latency, and a guest who skips calibration
    // should still land in the right neighbourhood (v4 Part 4).
    expect(resolveCalibration(base)).toEqual({
      offsetMs: 100,
      source: 'default',
      presetKey: null,
      at: NOW,
    });
  });

  it('uses the automatic seed when there is one', () => {
    expect(resolveCalibration({ ...base, outputLatencySec: 0.19 })).toMatchObject({
      offsetMs: 190,
      source: 'output-latency',
    });
  });

  it('prefers an explicit device preset over the seed', () => {
    const resolved = resolveCalibration({
      ...base,
      outputLatencySec: 0.19,
      presetKey: 'airpods',
    });
    expect(resolved).toMatchObject({ offsetMs: 160, source: 'preset', presetKey: 'airpods' });
  });

  it('applies a stored user calibration without asking again', () => {
    // The guest calibrated once. Making them do it on every return is how you
    // get a room full of people who skipped it.
    const stored: Calibration = { offsetMs: 175, source: 'user', presetKey: null, at: NOW - 1000 };
    expect(resolveCalibration({ ...base, stored, outputLatencySec: 0.19 })).toEqual(stored);
  });

  it('lets a fresh preset choice beat a stored user value', () => {
    // Swapping headphones moves latency ~200 ms, so picking a new device class
    // has to win over what was saved for the old one.
    const stored: Calibration = { offsetMs: 175, source: 'user', presetKey: null, at: NOW - 1000 };
    expect(resolveCalibration({ ...base, stored, presetKey: 'wired' })).toMatchObject({
      offsetMs: 0,
      source: 'preset',
    });
  });

  it('ignores a preset key the server does not define', () => {
    // The preset table is server-driven and can change mid-event (D11); a stale
    // key must not resolve to undefined.
    expect(resolveCalibration({ ...base, presetKey: 'bone-conduction' })).toMatchObject({
      source: 'default',
      offsetMs: 100,
    });
  });

  it('keeps a stored non-user value when nothing better is available', () => {
    const stored: Calibration = { offsetMs: 200, source: 'preset', presetKey: 'bluetooth', at: 1 };
    expect(resolveCalibration({ ...base, stored })).toEqual(stored);
  });
});

describe('persistence', () => {
  const calibration: Calibration = { offsetMs: 185, source: 'user', presetKey: 'airpods', at: NOW };

  it('round-trips', () => {
    const storage = new MemoryStorage();
    saveCalibration(storage, calibration);
    expect(loadCalibration(storage)).toEqual(calibration);
  });

  it('returns null for an empty store', () => {
    expect(loadCalibration(new MemoryStorage())).toBeNull();
  });

  it('discards corrupt values rather than repairing them', () => {
    // A silently repaired value is a guest dancing to a beat nobody else hears,
    // with no way for them to tell.
    const storage = new MemoryStorage();
    for (const bad of [
      'not json',
      '{}',
      '{"offsetMs":"180"}',
      '{"offsetMs":null,"source":"user"}',
      '{"offsetMs":180,"source":"admin"}',
      '{"offsetMs":9000,"source":"user"}',
      '{"offsetMs":-9000,"source":"user"}',
    ]) {
      storage.map.set(STORAGE_KEY, bad);
      expect(loadCalibration(storage), bad).toBeNull();
    }
  });

  it('survives storage that throws', () => {
    // Safari in private mode throws on access rather than returning null.
    const storage = new MemoryStorage();
    storage.throwOnAccess = true;
    expect(loadCalibration(storage)).toBeNull();
    expect(() => saveCalibration(storage, calibration)).not.toThrow();
    expect(() => clearCalibration(storage)).not.toThrow();
  });

  it('clears', () => {
    const storage = new MemoryStorage();
    saveCalibration(storage, calibration);
    clearCalibration(storage);
    expect(loadCalibration(storage)).toBeNull();
  });
});

describe('shouldSuggestRecalibration', () => {
  it('suggests it when there is nothing saved', () => {
    expect(shouldSuggestRecalibration(null, NOW)).toBe(true);
  });

  it('suggests it when the value came from a preset or a seed', () => {
    // Neither has been checked by an ear.
    expect(
      shouldSuggestRecalibration({ offsetMs: 160, source: 'preset', presetKey: 'airpods', at: NOW }, NOW),
    ).toBe(true);
    expect(
      shouldSuggestRecalibration({ offsetMs: 190, source: 'output-latency', presetKey: null, at: NOW }, NOW),
    ).toBe(true);
  });

  it('stays quiet for a recent user calibration', () => {
    const fresh: Calibration = { offsetMs: 175, source: 'user', presetKey: null, at: NOW - 60_000 };
    expect(shouldSuggestRecalibration(fresh, NOW)).toBe(false);
  });

  it('suggests it again for a stale one', () => {
    const old: Calibration = { offsetMs: 175, source: 'user', presetKey: null, at: NOW - 13 * 3_600_000 };
    expect(shouldSuggestRecalibration(old, NOW)).toBe(true);
  });
});
