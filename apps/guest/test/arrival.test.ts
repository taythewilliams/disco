import { describe, expect, it } from 'vitest';
import {
  DownloadRate,
  arrivalPhase,
  estimateCatchUpSec,
  phaseHeadline,
  showsReconnecting,
  type ArrivalInputs,
} from '../src/arrival.js';
import {
  BEAT_MS,
  CALIBRATION_BEATS,
  LOOP_MS,
  beatPhase,
  loopHits,
  renderHat,
  renderKick,
} from '../src/calibrationLoop.js';

const inputs = (over: Partial<ArrivalInputs> = {}): ArrivalInputs => ({
  joined: true,
  joinFailed: false,
  calibrated: true,
  haveState: true,
  channelPlaying: true,
  channelPaused: false,
  audioReady: true,
  connectionLost: false,
  ...over,
});

describe('arrivalPhase', () => {
  it('walks the happy path', () => {
    expect(arrivalPhase(inputs({ joined: false, haveState: false }))).toBe('joining');
    expect(arrivalPhase(inputs({ calibrated: false }))).toBe('calibrating');
    expect(arrivalPhase(inputs({ audioReady: false }))).toBe('catching-up');
    expect(arrivalPhase(inputs())).toBe('playing');
  });

  it('shows the wrong-code state and stays there', () => {
    expect(arrivalPhase(inputs({ joinFailed: true, joined: false, haveState: false }))).toBe(
      'join-failed',
    );
    // Even mid-flight: a rejected code is not something a retry loop fixes.
    expect(arrivalPhase(inputs({ joinFailed: true }))).toBe('join-failed');
  });

  it('calibrates before joining the stream', () => {
    // Joining uncalibrated is joining at the wrong time (D1), so this comes
    // before anything about playback.
    expect(arrivalPhase(inputs({ calibrated: false, channelPlaying: true, audioReady: true }))).toBe(
      'calibrating',
    );
  });

  it('distinguishes an idle channel from a paused one', () => {
    expect(arrivalPhase(inputs({ channelPlaying: false }))).toBe('waiting-for-dj');
    expect(arrivalPhase(inputs({ channelPaused: true }))).toBe('paused');
  });

  it('keeps playing through a server outage', () => {
    // D17: phones with buffered audio keep going on the schedule they already
    // know. Showing "reconnecting" instead of "playing" would be a lie, and the
    // guest would take their headphones off.
    expect(arrivalPhase(inputs({ connectionLost: true }))).toBe('playing');
  });

  it('goes offline only when there is nothing to play', () => {
    expect(arrivalPhase(inputs({ connectionLost: true, audioReady: false }))).toBe('offline');
    expect(arrivalPhase(inputs({ connectionLost: true, haveState: false, joined: false }))).toBe(
      'offline',
    );
  });

  it('shows the reconnecting indicator alongside playback, not instead of it', () => {
    expect(showsReconnecting('playing', true)).toBe(true);
    expect(showsReconnecting('playing', false)).toBe(false);
    // Not during the initial join, where it would just be noise.
    expect(showsReconnecting('joining', true)).toBe(false);
    expect(showsReconnecting('join-failed', true)).toBe(false);
  });
});

describe('phaseHeadline', () => {
  it('names each phase', () => {
    expect(phaseHeadline('playing', null)).toBe('Playing');
    expect(phaseHeadline('waiting-for-dj', null)).toBe('Waiting for the DJ');
  });

  it('includes the countdown only when there is one', () => {
    // A confidently wrong countdown is worse than none: a guest watches it.
    expect(phaseHeadline('catching-up', 20)).toBe('Catching up — 20s');
    expect(phaseHeadline('catching-up', null)).toBe('Catching up…');
  });
});

describe('DownloadRate and catch-up estimate', () => {
  it('has no opinion until it has seen a download', () => {
    const rate = new DownloadRate();
    expect(rate.bytesPerMs).toBeNull();
    expect(estimateCatchUpSec(1_000_000, rate)).toBeNull();
  });

  it('estimates from the first sample, then smooths', () => {
    const rate = new DownloadRate(0.3);
    rate.record(600_000, 1_000); // 600 B/ms ≈ 4.8 Mbps
    expect(rate.bytesPerMs).toBe(600);

    rate.record(300_000, 1_000);
    // A single slow segment moves the estimate, but does not become it.
    expect(rate.bytesPerMs).toBeGreaterThan(400);
    expect(rate.bytesPerMs).toBeLessThan(600);
  });

  it('ignores nonsense samples', () => {
    const rate = new DownloadRate();
    rate.record(0, 1_000);
    rate.record(1_000, 0);
    rate.record(1_000, -5);
    expect(rate.samples).toBe(0);
  });

  it('turns bytes remaining into seconds', () => {
    const rate = new DownloadRate();
    rate.record(600_000, 1_000);
    expect(estimateCatchUpSec(1_200_000, rate)).toBe(2);
    expect(estimateCatchUpSec(0, rate)).toBe(0);
  });
});

describe('calibration loop', () => {
  it('puts a kick on every beat and a hat on every offbeat', () => {
    // The offbeat hats are not decoration: they give the ear a subdivision to
    // judge against, which sharpens the rhythmic judgement (D1).
    const hits = loopHits();
    expect(hits.filter((h) => h.kind === 'kick')).toHaveLength(CALIBRATION_BEATS);
    expect(hits.filter((h) => h.kind === 'hat')).toHaveLength(CALIBRATION_BEATS);

    const kicks = hits.filter((h) => h.kind === 'kick').map((h) => h.atMs);
    expect(kicks).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
    const hats = hits.filter((h) => h.kind === 'hat').map((h) => h.atMs);
    expect(hats[0]).toBe(250);
  });

  it('is two bars at 120 bpm', () => {
    expect(BEAT_MS).toBe(500);
    expect(LOOP_MS).toBe(4_000);
  });

  it('reports the visual pulse position across the beat', () => {
    // Phase runs 0 → 1 so a renderer can decay a flash rather than blink it.
    expect(beatPhase(10, 10)).toEqual({ beat: 0, phase: 0 });
    expect(beatPhase(10.25, 10)).toEqual({ beat: 0, phase: 0.5 });
    expect(beatPhase(10.5, 10)).toEqual({ beat: 1, phase: 0 });
    expect(beatPhase(12, 10)).toEqual({ beat: 4, phase: 0 });
  });

  it('reports nothing before the loop starts', () => {
    expect(beatPhase(9.9, 10)).toBeNull();
  });

  it('synthesises a kick with a sharp attack', () => {
    // A soft onset is exactly what a guest cannot place in time.
    const kick = renderKick(44_100);
    expect(kick.length).toBe(Math.floor(44_100 * 0.25));
    const peak = Math.max(...Array.from(kick).map(Math.abs));
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThanOrEqual(1);
    // Decayed to a couple of percent by the end, so hits do not smear into each
    // other at a 250 ms spacing.
    const tail = Math.max(...Array.from(kick.slice(-256)).map(Math.abs));
    expect(tail).toBeLessThan(peak * 0.05);
  });

  it('synthesises an identical hat on every device', () => {
    // A seeded PRNG, not Math.random: the method has to be the same for
    // everyone, or the variance it adds is variance in the measurement (D1).
    const a = renderHat(44_100);
    const b = renderHat(44_100);
    expect(Array.from(a.slice(0, 64))).toEqual(Array.from(b.slice(0, 64)));
    expect(a.length).toBe(Math.floor(44_100 * 0.06));
  });

  it('scales synthesis with the sample rate', () => {
    expect(renderKick(48_000).length).toBe(Math.floor(48_000 * 0.25));
  });
});

describe('server-driven copy', () => {
  it('prefers the configured string over the built-in one', () => {
    // Wording is the thing most likely to need changing mid-event, and a
    // redeploy at 11pm is not an option (D11).
    const strings = {
      trackNotReady: 'Nearly there',
      serverUnreachable: 'Hang tight',
      joinFailed: 'Wrong code, sorry',
    };
    expect(phaseHeadline('catching-up', 12, strings)).toBe('Nearly there — 12s');
    expect(phaseHeadline('offline', null, strings)).toBe('Hang tight');
    expect(phaseHeadline('join-failed', null, strings)).toBe('Wrong code, sorry');
  });

  it('falls back rather than rendering blank when a key is missing', () => {
    // A half-filled strings table must not produce an empty screen.
    expect(phaseHeadline('offline', null, {})).toBe('Reconnecting…');
    expect(phaseHeadline('catching-up', null, {})).toBe('Catching up…');
  });

  it('appends the countdown to whatever the configured base is', () => {
    expect(phaseHeadline('catching-up', 20, { trackNotReady: 'Buffering' })).toBe(
      'Buffering — 20s',
    );
  });
});
