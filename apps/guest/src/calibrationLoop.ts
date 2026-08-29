/**
 * The calibration loop (D1).
 *
 * A repeating two-bar pattern — kick on the beats, hi-hat on the offbeats — with
 * a visual pulse on the beat, drawn on the guest's own phone. The guest drags a
 * slider until sound and pulse read as simultaneous.
 *
 * Why a loop and not a click: rhythmic alignment judgement is far better than
 * one-shot simultaneity, because there are several bars to lock into. Expect
 * ±30 ms from non-musicians, ±10 ms from musicians.
 *
 * Why the visual is on the phone: we control both screen and audio on that
 * device, phone display latency is small and roughly uniform, and it removes any
 * need for line of sight across a dark room.
 *
 * **The loop is synthesised, not bundled.** D1 budgeted a few hundred kilobytes
 * of audio in the app shell; generating it from a formula is better on both
 * counts that matter. It costs zero bytes against the 1 MB shell budget (D4),
 * and it is bit-identical on every device — which is the whole requirement,
 * since variance between guests is what the calibration is fighting (Part 0).
 */

/** 120 BPM: a 500 ms beat, unambiguous to tap along with and easy to feel. */
export const CALIBRATION_BPM = 120;
export const BEAT_MS = 60_000 / CALIBRATION_BPM;
/** Two bars of 4/4. Long enough to lock into, short enough to loop invisibly. */
export const CALIBRATION_BEATS = 8;
export const LOOP_MS = BEAT_MS * CALIBRATION_BEATS;

export type HitKind = 'kick' | 'hat';

export interface LoopHit {
  kind: HitKind;
  /** Offset from the top of the loop. */
  atMs: number;
  /** Which beat this belongs to, for the visual pulse. */
  beat: number;
}

/**
 * One loop's worth of hits.
 *
 * Kick on every beat, hi-hat on every offbeat. The offbeat hats are not
 * decoration: they give the ear a subdivision to judge against, which is what
 * makes a rhythmic judgement sharper than a single click.
 */
export function loopHits(): LoopHit[] {
  const hits: LoopHit[] = [];
  for (let beat = 0; beat < CALIBRATION_BEATS; beat++) {
    hits.push({ kind: 'kick', atMs: beat * BEAT_MS, beat });
    hits.push({ kind: 'hat', atMs: beat * BEAT_MS + BEAT_MS / 2, beat });
  }
  return hits;
}

/**
 * Where the visual pulse should be at a given time.
 *
 * `phase` runs 0 → 1 across the beat, so a renderer can decay a flash rather
 * than blink it. Returns null before the loop starts.
 */
export function beatPhase(
  currentTimeSec: number,
  startTimeSec: number,
  beatMs: number = BEAT_MS,
): { beat: number; phase: number } | null {
  if (currentTimeSec < startTimeSec) return null;
  const elapsedMs = (currentTimeSec - startTimeSec) * 1000;
  const beat = Math.floor(elapsedMs / beatMs);
  return { beat, phase: (elapsedMs % beatMs) / beatMs };
}

// ─── Synthesis ──────────────────────────────────────────────────────────────

/**
 * A kick with a pitch sweep and a fast decay.
 *
 * The sweep is what makes the attack legible: a pure 55 Hz sine has a soft
 * onset, and a soft onset is exactly what a guest cannot place in time.
 */
export function renderKick(sampleRate: number): Float32Array {
  const durationSec = 0.25;
  const samples = Math.floor(sampleRate * durationSec);
  const data = new Float32Array(samples);
  let phase = 0;

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    // 120 Hz down to 45 Hz over ~40 ms.
    const frequency = 45 + 75 * Math.exp(-t / 0.04);
    phase += (2 * Math.PI * frequency) / sampleRate;
    const envelope = Math.exp(-t / 0.06);
    data[i] = Math.sin(phase) * envelope * 0.9;
  }
  return data;
}

/**
 * A hi-hat: a very short, very bright noise burst.
 *
 * Differencing successive noise samples is a one-line high-pass — enough to put
 * the energy where a hat lives without pulling in a filter node, and
 * deterministic given the same PRNG, which matters because every guest must hear
 * exactly the same thing.
 */
export function renderHat(sampleRate: number): Float32Array {
  const durationSec = 0.06;
  const samples = Math.floor(sampleRate * durationSec);
  const data = new Float32Array(samples);
  const random = mulberry32(0x5eed);
  let previous = 0;

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const noise = random() * 2 - 1;
    const highPassed = noise - previous;
    previous = noise;
    data[i] = highPassed * Math.exp(-t / 0.012) * 0.35;
  }
  return data;
}

/**
 * A seeded PRNG.
 *
 * `Math.random()` would give every guest a subtly different hi-hat. That is
 * unlikely to matter, and it is free to rule out — the method has to be
 * identical for everyone or the variance it introduces is variance in the
 * measurement (D1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Playback ───────────────────────────────────────────────────────────────

/** How far ahead hits are scheduled, and how often the scheduler wakes. */
const LOOKAHEAD_SEC = 0.3;
const SCHEDULER_INTERVAL_MS = 60;

/**
 * Plays the loop and reports where the visual pulse should be.
 *
 * The offset shifts *audio earlier*, never the visual: the visual grid is the
 * reference the guest is judging against, and moving it would change what they
 * are being asked to compare.
 */
export class CalibrationLoopPlayer {
  readonly #context: AudioContext;
  readonly #gain: GainNode;
  #kick: AudioBuffer | null = null;
  #hat: AudioBuffer | null = null;

  /** Context time of the loop's first beat. The visual grid's origin. */
  #startTime = 0;
  #nextLoopIndex = 0;
  #offsetSec = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(context: AudioContext, volume = 0.8) {
    this.#context = context;
    this.#gain = context.createGain();
    this.#gain.gain.value = volume;
    this.#gain.connect(context.destination);
  }

  prepare(): void {
    const rate = this.#context.sampleRate;
    this.#kick = toBuffer(this.#context, renderKick(rate));
    this.#hat = toBuffer(this.#context, renderHat(rate));
  }

  get startTime(): number {
    return this.#startTime;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer) return;
    if (!this.#kick) this.prepare();

    // A little lead so the first hit is scheduled rather than fired late.
    this.#startTime = this.#context.currentTime + 0.15;
    this.#nextLoopIndex = 0;
    this.#schedule();
    this.#timer = setInterval(() => this.#schedule(), SCHEDULER_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** The guest's current estimate of their output latency. */
  setOffsetMs(ms: number): void {
    this.#offsetSec = ms / 1000;
  }

  /** Where the pulse should be right now, for the renderer. */
  pulse(): { beat: number; phase: number } | null {
    if (!this.#timer) return null;
    return beatPhase(this.#context.currentTime, this.#startTime);
  }

  dispose(): void {
    this.stop();
    this.#gain.disconnect();
  }

  /** Schedule every loop that begins inside the lookahead window. */
  #schedule(): void {
    const horizon = this.#context.currentTime + LOOKAHEAD_SEC;
    while (this.#startTime + (this.#nextLoopIndex * LOOP_MS) / 1000 < horizon) {
      const loopStart = this.#startTime + (this.#nextLoopIndex * LOOP_MS) / 1000;
      for (const hit of loopHits()) {
        // Audio is emitted early by the guest's offset so that, once it has
        // travelled the output path, it lands on the visual grid.
        const when = loopStart + hit.atMs / 1000 - this.#offsetSec;
        if (when >= this.#context.currentTime) this.#fire(hit.kind, when);
      }
      this.#nextLoopIndex++;
    }
  }

  #fire(kind: HitKind, when: number): void {
    const buffer = kind === 'kick' ? this.#kick : this.#hat;
    if (!buffer) return;
    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#gain);
    source.start(when);
  }
}

function toBuffer(context: AudioContext, data: Float32Array): AudioBuffer {
  const buffer = context.createBuffer(1, data.length, context.sampleRate);
  // `getChannelData` and a set, rather than `copyToChannel`: the latter's
  // TypeScript signature demands a `Float32Array<ArrayBuffer>` specifically, and
  // a plain `Float32Array` is not assignable to it.
  buffer.getChannelData(0).set(data);
  return buffer;
}
