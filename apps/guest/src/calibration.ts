/**
 * Output-latency calibration (D1).
 *
 * The single most important number in the system. Per v4 Part 0, calibration
 * variance *between guests* is the dominant term in the error budget — every
 * other term is already small — and a uniform delay is inaudible. So the target
 * here is precision, not accuracy: a method that is consistently 30 ms wrong is
 * better than one that is right on average and scattered.
 *
 * Three layers, most-trusted last:
 *
 * 1. `AudioContext.outputLatency` — a hint. Android Chrome reports something
 *    that partly reflects the real audio path; Safari is unreliable. Never truth.
 * 2. A device preset, server-driven so a bad value can be corrected mid-event.
 * 3. The guest's own slider refinement, which overrides both.
 */

/**
 * Slider bounds.
 *
 * Negative is allowed but small: it means the guest perceives the *sound* ahead
 * of the pulse, which happens on a wired device where display latency exceeds
 * audio latency. The upper bound covers the worst Bluetooth path with room to
 * spare; wider would only add places for a mis-drag to hide.
 */
export const CALIBRATION_MIN_MS = -100;
export const CALIBRATION_MAX_MS = 600;

/**
 * Slider granularity.
 *
 * 5 ms is far below the ~25 ms standard deviation Spike 3 targets, so
 * quantisation adds nothing measurable to the spread — while a continuous
 * slider invites fiddling, and fiddling is variance.
 */
export const CALIBRATION_STEP_MS = 5;

/** Where the number came from, so the UI can say so and telemetry can group by it. */
export type CalibrationSource = 'default' | 'output-latency' | 'preset' | 'user';

export interface Calibration {
  offsetMs: number;
  source: CalibrationSource;
  /** Device class the guest chose, when they chose one. */
  presetKey: string | null;
  /** Wall-clock ms when this was decided. Only ever displayed, never computed on. */
  at: number;
}

export const STORAGE_KEY = 'disco.calibration.v1';

export function clampCalibration(ms: number): number {
  // NaN has no side to be clamped to, so it becomes zero. Infinities do, and
  // `Math.max`/`Math.min` handle them correctly — turning +Infinity into 0
  // would be a surprising jump to the wrong end of the range.
  if (Number.isNaN(ms)) return 0;
  return Math.max(CALIBRATION_MIN_MS, Math.min(CALIBRATION_MAX_MS, ms));
}

/** Round to the slider's step, so a stored value and a slider position agree. */
export function quantiseCalibration(ms: number): number {
  return Math.round(clampCalibration(ms) / CALIBRATION_STEP_MS) * CALIBRATION_STEP_MS;
}

/**
 * Layer 1: the automatic seed.
 *
 * `outputLatency` is in seconds and is frequently 0, absent, or absurd. Anything
 * outside a plausible audio path is discarded rather than trusted — a seed of
 * 4 seconds would put a guest a bar behind the room before they touched
 * anything.
 */
export function seedFromOutputLatency(outputLatencySec: number | undefined): number | null {
  if (typeof outputLatencySec !== 'number' || !Number.isFinite(outputLatencySec)) return null;
  const ms = outputLatencySec * 1000;
  if (ms <= 0 || ms > CALIBRATION_MAX_MS) return null;
  return quantiseCalibration(ms);
}

export interface ResolveInputs {
  /** What the guest saved last time, if anything. */
  stored: Calibration | null;
  /** Layer 1. */
  outputLatencySec: number | undefined;
  /** Layer 2: the class the guest picked, and the server's table for it (D11). */
  presetKey: string | null;
  presets: Record<string, number>;
  now: number;
}

/**
 * Decide the calibration to apply right now.
 *
 * A stored user value always wins and is applied without asking — the guest
 * calibrated once and should not be made to do it again on every return. A
 * stored preset choice is weaker than a fresh explicit one, so a guest who
 * swaps headphones and picks a new class gets the new class.
 */
export function resolveCalibration(inputs: ResolveInputs): Calibration {
  const { stored, outputLatencySec, presetKey, presets, now } = inputs;

  if (presetKey !== null && presets[presetKey] !== undefined) {
    return {
      offsetMs: quantiseCalibration(presets[presetKey] as number),
      source: 'preset',
      presetKey,
      at: now,
    };
  }

  if (stored && stored.source === 'user') return stored;

  const seed = seedFromOutputLatency(outputLatencySec);
  if (seed !== null) {
    return { offsetMs: seed, source: 'output-latency', presetKey: null, at: now };
  }

  if (stored) return stored;

  // The floor. A guest who skips calibration entirely still lands in the right
  // neighbourhood rather than at zero, which no real device is (D1, and the
  // "guest skips calibration" risk in v4 Part 4).
  const fallback = presets['generic'];
  return {
    offsetMs: quantiseCalibration(fallback ?? 100),
    source: 'default',
    presetKey: null,
    at: now,
  };
}

/** The narrow slice of `Storage` this needs, so tests need no browser. */
export interface CalibrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Read a stored calibration.
 *
 * Anything unparseable, out of range or of the wrong shape is discarded rather
 * than repaired: a corrupt value silently applied is a guest dancing to a beat
 * nobody else hears, and there is no way for them to know.
 */
export function loadCalibration(storage: CalibrationStorage): Calibration | null {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    // Safari in private mode throws on access rather than returning null.
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<Calibration>;
    if (typeof parsed.offsetMs !== 'number' || !Number.isFinite(parsed.offsetMs)) return null;
    if (parsed.offsetMs < CALIBRATION_MIN_MS || parsed.offsetMs > CALIBRATION_MAX_MS) return null;
    if (!isSource(parsed.source)) return null;
    return {
      offsetMs: parsed.offsetMs,
      source: parsed.source,
      presetKey: typeof parsed.presetKey === 'string' ? parsed.presetKey : null,
      at: typeof parsed.at === 'number' ? parsed.at : 0,
    };
  } catch {
    return null;
  }
}

export function saveCalibration(storage: CalibrationStorage, calibration: Calibration): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(calibration));
  } catch {
    // Storage full or blocked. The calibration still applies for this session;
    // losing it on reload is a far smaller problem than failing to apply it now.
  }
}

export function clearCalibration(storage: CalibrationStorage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do, and nothing worth telling the guest.
  }
}

function isSource(value: unknown): value is CalibrationSource {
  return value === 'default' || value === 'output-latency' || value === 'preset' || value === 'user';
}

/**
 * Whether to nudge the guest to recalibrate.
 *
 * Not a detector — headphone swaps cannot be detected reliably on the web, and
 * a swap moves latency by ~200 ms. The recalibrate button is permanently
 * visible for exactly that reason (D1); this only decides whether to draw
 * attention to it on return.
 */
export function shouldSuggestRecalibration(
  calibration: Calibration | null,
  now: number,
  maxAgeMs = 12 * 60 * 60 * 1000,
): boolean {
  if (!calibration) return true;
  if (calibration.source !== 'user') return true;
  return now - calibration.at > maxAgeMs;
}
