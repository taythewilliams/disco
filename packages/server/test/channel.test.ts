import { describe, expect, it } from 'vitest';
import { Channel } from '../src/channel.js';

const DURATIONS: Record<string, number> = { a: 180_000, b: 200_000, c: 30_000, d: 240_000 };

const channel = () =>
  new Channel('main', { durationOf: (id) => DURATIONS[id] });

const T0 = 1_000_000;

describe('Channel — transport', () => {
  it('starts empty and stays empty', () => {
    const c = channel();
    expect(c.snapshot()).toEqual({
      trackId: null,
      startAtServerTime: 0,
      paused: false,
      pausedAtPosition: null,
      queue: [],
    });
    expect(c.play(T0)).toBe(true); // advances to nothing
    expect(c.currentTrackId).toBeNull();
  });

  it('plays the head of the queue', () => {
    const c = channel();
    c.setQueue(['a', 'b'], T0);
    c.play(T0);
    expect(c.snapshot()).toMatchObject({
      trackId: 'a',
      startAtServerTime: T0,
      paused: false,
      queue: ['b'],
    });
  });

  it('reports position as the difference from the start and nothing else', () => {
    const c = channel();
    c.setQueue(['a'], T0);
    c.play(T0);
    expect(c.positionMs(T0 + 45_000)).toBe(45_000);
  });

  it('resumes where the room was, not at the top of the track', () => {
    const c = channel();
    c.setQueue(['a'], T0);
    c.play(T0);
    c.pause(T0 + 45_000);
    expect(c.snapshot()).toMatchObject({ paused: true, pausedAtPosition: 45_000 });

    // Ten minutes of pause must not move the playhead.
    expect(c.positionMs(T0 + 600_000)).toBe(45_000);

    c.play(T0 + 600_000);
    expect(c.positionMs(T0 + 600_000)).toBe(45_000);
    expect(c.positionMs(T0 + 601_000)).toBe(46_000);
  });

  it('ignores a pause when nothing is playing, and a double pause', () => {
    const c = channel();
    expect(c.pause(T0)).toBe(false);
    c.setQueue(['a'], T0);
    c.play(T0);
    expect(c.pause(T0 + 1_000)).toBe(true);
    expect(c.pause(T0 + 2_000)).toBe(false);
    expect(c.snapshot().pausedAtPosition).toBe(1_000);
  });

  it('seeks by moving the origin, keeping one meaning for the timeline', () => {
    const c = channel();
    c.setQueue(['a'], T0);
    c.play(T0);
    c.seek(90_000, T0 + 10_000);
    expect(c.positionMs(T0 + 10_000)).toBe(90_000);
    expect(c.snapshot().startAtServerTime).toBe(T0 - 80_000);
  });

  it('seeks while paused without unpausing', () => {
    const c = channel();
    c.setQueue(['a'], T0);
    c.play(T0);
    c.pause(T0 + 5_000);
    c.seek(120_000, T0 + 6_000);
    expect(c.snapshot()).toMatchObject({ paused: true, pausedAtPosition: 120_000 });
  });

  it('clamps a negative seek rather than scheduling in the future', () => {
    const c = channel();
    c.setQueue(['a'], T0);
    c.play(T0);
    c.seek(-5_000, T0);
    expect(c.positionMs(T0)).toBe(0);
  });

  it('jumps straight to a named track and takes it out of the queue', () => {
    const c = channel();
    c.setQueue(['a', 'b', 'c'], T0);
    c.play(T0);
    c.play(T0 + 1_000, 'c');
    expect(c.snapshot()).toMatchObject({ trackId: 'c', startAtServerTime: T0 + 1_000, queue: ['b'] });
  });

  it('honours an explicit start time and position', () => {
    const c = channel();
    c.setQueue(['a'], T0);
    c.play(T0, 'a', 30_000, T0 + 5_000);
    expect(c.positionMs(T0 + 5_000)).toBe(30_000);
  });

  it('stops when the queue runs out on a skip', () => {
    const c = channel();
    c.setQueue(['a'], T0);
    c.play(T0);
    c.skip(T0 + 1_000);
    expect(c.snapshot()).toEqual({
      trackId: null,
      startAtServerTime: 0,
      paused: false,
      pausedAtPosition: null,
      queue: [],
    });
  });
});

describe('Channel — queue', () => {
  it('does not interrupt the playing track when the queue is replaced', () => {
    // Re-ordering what comes next is the single most common live action; it
    // must never restart what is playing.
    const c = channel();
    c.setQueue(['a', 'b'], T0);
    c.play(T0);
    c.setQueue(['d', 'c'], T0 + 30_000);
    expect(c.snapshot()).toMatchObject({ trackId: 'a', startAtServerTime: T0, queue: ['d', 'c'] });
    expect(c.positionMs(T0 + 30_000)).toBe(30_000);
  });

  it('keeps publication time across a re-order', () => {
    // A track visible to the room for four minutes does not become unready by
    // being moved up the list (D5).
    const c = channel();
    c.setQueue(['a', 'b'], T0);
    c.setQueue(['b', 'a'], T0 + 240_000);
    expect(c.readyAt('b', 180_000)).toBe(T0 + 180_000);
  });

  it('reports the prefetch horizon as current plus the next N', () => {
    const c = channel();
    c.setQueue(['a', 'b', 'c', 'd'], T0);
    c.play(T0);
    expect(c.horizon(2)).toEqual(['a', 'b', 'c']);
    expect(c.horizon(0)).toEqual(['a']);
  });
});

describe('Channel — auto-advance', () => {
  it('starts the next track at the previous one’s exact end, not at the tick', () => {
    // This is what makes transitions gapless and gives every client an
    // identical schedule: a tick is always a little late, and pinning the
    // boundary to the previous end removes that lateness from the timeline.
    const c = channel();
    c.setQueue(['a', 'b'], T0);
    c.play(T0);

    const lateTick = T0 + DURATIONS['a']! + 187;
    expect(c.tick(lateTick)).toBe(true);
    expect(c.snapshot()).toMatchObject({
      trackId: 'b',
      startAtServerTime: T0 + DURATIONS['a']!,
    });
    expect(c.positionMs(lateTick)).toBe(187);
  });

  it('does nothing before the track ends', () => {
    const c = channel();
    c.setQueue(['a', 'b'], T0);
    c.play(T0);
    expect(c.tick(T0 + DURATIONS['a']! - 1)).toBe(false);
    expect(c.currentTrackId).toBe('a');
  });

  it('catches up across several tracks after a stalled tick', () => {
    // 'c' is 30 s long. A tick delayed by a minute has to skip it entirely
    // rather than fall a track behind and stay there.
    const c = channel();
    c.setQueue(['c', 'c', 'a'], T0);
    c.play(T0);
    expect(c.tick(T0 + 65_000)).toBe(true);
    expect(c.snapshot()).toMatchObject({ trackId: 'a', startAtServerTime: T0 + 60_000 });
  });

  it('stops at the end of the queue', () => {
    const c = channel();
    c.setQueue(['c'], T0);
    c.play(T0);
    c.tick(T0 + 40_000);
    expect(c.currentTrackId).toBeNull();
    expect(c.tick(T0 + 50_000)).toBe(false);
  });

  it('does not advance while paused', () => {
    const c = channel();
    c.setQueue(['c', 'a'], T0);
    c.play(T0);
    c.pause(T0 + 1_000);
    expect(c.tick(T0 + 900_000)).toBe(false);
    expect(c.currentTrackId).toBe('c');
  });

  it('holds position when a track is missing from the manifest', () => {
    // Queue and manifest disagreeing is a bug elsewhere; the safe response is
    // to keep playing what the room already has rather than to skip blindly.
    const c = new Channel('main', { durationOf: () => undefined });
    c.setQueue(['ghost', 'a'], T0);
    c.play(T0);
    expect(c.tick(T0 + 10_000_000)).toBe(false);
    expect(c.currentTrackId).toBe('ghost');
  });
});

describe('Channel — wire format', () => {
  it('produces the state message clients compute position from', () => {
    const c = channel();
    c.setQueue(['a', 'b'], T0);
    c.play(T0);
    expect(c.toStateMessage()).toEqual({
      t: 'state',
      channelId: 'main',
      trackId: 'a',
      startAtServerTime: T0,
      paused: false,
      pausedAtPosition: null,
      queue: ['b'],
    });
  });
});
