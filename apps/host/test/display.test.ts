import { describe, expect, it } from 'vitest';
import { FrameRate, frameFor } from '../src/display/visuals.js';
import { joinUrl, qrPath } from '../src/display/qr.js';

const size = { width: 1920, height: 1080 };

describe('frameFor', () => {
  it('flashes on the beat and settles between beats', () => {
    const onBeat = frameFor({ phase: { index: 4, sinceMs: 0, intervalMs: 500 }, positionMs: 0, ...size });
    const between = frameFor({
      phase: { index: 4, sinceMs: 240, intervalMs: 500 },
      positionMs: 0,
      ...size,
    });
    expect(onBeat.pulse).toBe(1);
    expect(between.pulse).toBeLessThan(onBeat.pulse);
    expect(onBeat.coreRadius).toBeGreaterThan(between.coreRadius);
  });

  it('rests when the track has no beat grid', () => {
    // No audio and no microphone on this machine: without a grid there is
    // nothing to pulse to, and inventing a tempo is worse than stillness (D8).
    const frame = frameFor({ phase: null, positionMs: 30_000, ...size });
    expect(frame.pulse).toBe(0);
    expect(frame.rings).toEqual([]);
    expect(frame.onBar).toBe(false);
  });

  it('trails the last few beats as expanding rings', () => {
    const frame = frameFor({ phase: { index: 8, sinceMs: 10, intervalMs: 500 }, positionMs: 0, ...size });
    expect(frame.rings.length).toBeGreaterThan(1);
    // Older rings are wider and fainter.
    const [first, second] = frame.rings as [{ radius: number; alpha: number }, { radius: number; alpha: number }];
    expect(second.radius).toBeGreaterThan(first.radius);
    expect(second.alpha).toBeLessThan(first.alpha);
  });

  it('marks the bar line on every fourth beat', () => {
    // Structure people can dance to, rather than an identical flash every beat.
    expect(frameFor({ phase: { index: 8, sinceMs: 0, intervalMs: 500 }, positionMs: 0, ...size }).onBar).toBe(true);
    expect(frameFor({ phase: { index: 9, sinceMs: 0, intervalMs: 500 }, positionMs: 0, ...size }).onBar).toBe(false);
  });

  it('derives rotation from track position, not from frame count', () => {
    // Two machines showing the same track must agree, and a dropped frame must
    // not shift the phase.
    const a = frameFor({ phase: null, positionMs: 12_000, ...size });
    const b = frameFor({ phase: null, positionMs: 12_000, ...size });
    expect(a.rotation).toBe(b.rotation);
    expect(a.rotation).toBeGreaterThan(0);
  });

  it('scales to the smaller dimension so a portrait screen still fits', () => {
    const wide = frameFor({ phase: null, positionMs: 0, width: 1920, height: 1080 });
    const tall = frameFor({ phase: null, positionMs: 0, width: 1080, height: 1920 });
    expect(wide.coreRadius).toBe(tall.coreRadius);
  });
});

describe('FrameRate', () => {
  it('converges on the real rate', () => {
    const rate = new FrameRate();
    let t = 0;
    for (let i = 0; i < 200; i++) rate.sample((t += 1000 / 30));
    expect(rate.fps).toBeGreaterThan(29);
    expect(rate.fps).toBeLessThan(31);
  });

  it('survives a first sample and a stalled frame', () => {
    const rate = new FrameRate();
    expect(rate.sample(0)).toBe(60);
    expect(Number.isFinite(rate.sample(0))).toBe(true);
  });
});

describe('the join QR', () => {
  it('encodes the origin, not the display route', () => {
    // A guest scanning it must land on the PWA, not on the projector's page.
    expect(joinUrl({ origin: 'https://party.example.com' })).toBe('https://party.example.com/');
  });

  it('produces a square grid of modules', () => {
    const qr = qrPath('https://party.example.com/');
    expect(qr.size).toBeGreaterThanOrEqual(21);
    expect(qr.d.length).toBeGreaterThan(100);
    // Finder pattern: the top-left module of a QR is always dark.
    expect(qr.d.startsWith('M0 0h1v1h-1z')).toBe(true);
  });
});
