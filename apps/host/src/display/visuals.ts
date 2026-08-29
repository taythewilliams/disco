/**
 * The projector's visuals (D8).
 *
 * The display has no audio and no microphone. Everything it draws comes from
 * the ingested beat grid and the shared clock, which is exactly why the beat
 * grid was worth extracting during ingest rather than someday (D10).
 *
 * The frame maths is a pure function so the awkward parts — a track with no
 * detected beats, a position before the first one, a tab that was hidden for a
 * minute — are pinned by tests rather than found on a wall in front of a room.
 * Only `render` touches a canvas.
 *
 * Canvas 2D rather than WebGL. There is no audio to analyse and nothing here
 * needs a shader: it is a handful of arcs and a gradient at 60 Hz, and the
 * machine drawing it is also running the server and serving thirty phones (v4
 * Part 3, Phase 3's load test).
 */

import { beatPulse, type BeatGrid, type BeatPhase } from '@disco/shared';

export interface FrameInput {
  /** Beat phase at the drawn position, or null when there is no grid. */
  phase: BeatPhase | null;
  /** Track position being drawn, in ms. Used for the slow drift of the field. */
  positionMs: number;
  width: number;
  height: number;
}

export interface Frame {
  /** 0–1 flash following the beat. */
  pulse: number;
  /** Radius of the pulsing core, in pixels. */
  coreRadius: number;
  /** Expanding rings, oldest last. Radius in pixels, alpha 0–1. */
  rings: Array<{ radius: number; alpha: number }>;
  /** True on every fourth beat: the bar line, which reads as structure. */
  onBar: boolean;
  /** Slow rotation so a long track never looks frozen between beats. */
  rotation: number;
}

/** How many past beats leave a visible ring. More than this is soup. */
const RING_COUNT = 3;

export function frameFor(input: FrameInput): Frame {
  const { phase, width, height } = input;
  const shortest = Math.min(width, height);
  const pulse = beatPulse(phase);

  // Rings are the last few beats, still expanding. Without a grid there is
  // nothing to expand from, and the field falls back to its resting state
  // rather than inventing a tempo.
  const rings: Frame['rings'] = [];
  if (phase) {
    for (let age = 0; age < RING_COUNT; age++) {
      const sinceMs = phase.sinceMs + age * phase.intervalMs;
      const life = sinceMs / (phase.intervalMs * RING_COUNT);
      if (life >= 1) break;
      rings.push({ radius: shortest * (0.12 + life * 0.55), alpha: (1 - life) ** 2 * 0.5 });
    }
  }

  return {
    pulse,
    coreRadius: shortest * (0.16 + pulse * 0.06),
    rings,
    onBar: phase !== null && phase.index % 4 === 0 && pulse > 0.5,
    // Tied to position rather than to frame count, so two machines showing the
    // same track agree — and so a dropped frame does not shift the phase.
    rotation: (input.positionMs / 24_000) % (Math.PI * 2),
  };
}

export interface RenderOptions {
  hue: number;
  /** Dimmed while the transport is paused, so the room can see it is paused. */
  idle: boolean;
}

/**
 * Draw one frame.
 *
 * Deliberately additive and dark: a projector in a dark room is the brightest
 * object in it, and a full-brightness field is unpleasant to stand in front of
 * for three hours.
 */
export function render(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  { hue, idle }: RenderOptions,
): void {
  const { canvas } = ctx;
  const width = canvas.width;
  const height = canvas.height;
  const cx = width / 2;
  const cy = height / 2;
  const dim = idle ? 0.35 : 1;

  ctx.clearRect(0, 0, width, height);

  const wash = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(width, height) * 0.7);
  wash.addColorStop(0, `hsl(${hue} 60% ${8 + frame.pulse * 10 * dim}%)`);
  wash.addColorStop(1, 'hsl(230 30% 4%)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(frame.rotation);

  for (const ring of frame.rings) {
    ctx.beginPath();
    ctx.arc(0, 0, ring.radius, 0, Math.PI * 2);
    ctx.strokeStyle = `hsla(${hue} 85% 70% / ${ring.alpha * dim})`;
    ctx.lineWidth = Math.max(2, ring.radius * 0.012);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(0, 0, frame.coreRadius, 0, Math.PI * 2);
  ctx.fillStyle = `hsla(${hue} 80% 62% / ${(0.12 + frame.pulse * 0.5) * dim})`;
  ctx.fill();

  // The bar line: four spokes on every fourth beat. Structure people can dance
  // to, rather than an undifferentiated flash on every beat.
  if (frame.onBar) {
    ctx.strokeStyle = `hsla(${hue} 90% 78% / ${frame.pulse * 0.5 * dim})`;
    ctx.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * frame.coreRadius, Math.sin(angle) * frame.coreRadius);
      ctx.lineTo(Math.cos(angle) * frame.coreRadius * 2.4, Math.sin(angle) * frame.coreRadius * 2.4);
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * A rolling frame-rate estimate, for the load test (v4 Phase 3).
 *
 * The question this answers is whether one MacBook can run the server, serve
 * thirty phones and drive a full-screen visualiser at once — and if it cannot,
 * moving the display to a second machine is a config change by design (D8).
 */
export class FrameRate {
  #last: number | null = null;
  #ema = 60;

  sample(nowMs: number): number {
    if (this.#last !== null) {
      const delta = nowMs - this.#last;
      if (delta > 0) this.#ema = this.#ema * 0.9 + (1000 / delta) * 0.1;
    }
    this.#last = nowMs;
    return this.#ema;
  }

  get fps(): number {
    return this.#ema;
  }
}

export type { BeatGrid };
