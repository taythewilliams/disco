/**
 * Fakes for the browser APIs the engines drive.
 *
 * Deliberately dumb: they record what was asked of them and let a test move
 * time by hand. The point is that the scheduling maths — anchors, rate-aware
 * position, drift — is testable without a browser, an audio device, or a clock
 * that runs at real speed.
 */

import type { EngineClock } from '../src/engine/types.js';

export class FakeParam {
  value = 1;
  readonly automation: Array<{ kind: string; value: number; time: number }> = [];
  setValueAtTime(value: number, time: number): void {
    this.automation.push({ kind: 'set', value, time });
    this.value = value;
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.automation.push({ kind: 'linear', value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    this.automation.push({ kind: 'exponential', value, time });
  }
}

export class FakeGainNode {
  readonly gain = new FakeParam();
  connect(): void {}
  disconnect(): void {}
}

export class FakeBufferSource {
  buffer: unknown = null;
  readonly playbackRate = new FakeParam();
  startedAt: number | null = null;
  offsetSec: number | null = null;
  stoppedAt: number | null = null;
  connected = false;

  connect(): void {
    this.connected = true;
  }
  disconnect(): void {
    this.connected = false;
  }
  start(when: number, offset: number): void {
    if (this.startedAt !== null) throw new Error('already started');
    this.startedAt = when;
    this.offsetSec = offset;
  }
  stop(when?: number): void {
    if (this.startedAt === null) throw new Error('not started');
    this.stoppedAt = when ?? -1;
  }
}

export class FakeAudioContext {
  currentTime = 0;
  readonly destination = {};
  readonly sources: FakeBufferSource[] = [];
  closed = false;

  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  /** Move audio-context time forward, in seconds. */
  advance(seconds: number): void {
    this.currentTime += seconds;
  }
}

/**
 * A clock a test drives directly.
 *
 * `serverNow` and `toClientTime` are exact inverses through `offsetMs`, which is
 * what the real `ClockSync` provides once locked.
 */
export class FakeClock implements EngineClock {
  constructor(
    public clientMs = 0,
    public offsetMs = 0,
  ) {}

  now(): number {
    return this.clientMs;
  }
  serverNow(): number {
    return this.clientMs + this.offsetMs;
  }
  toClientTime(serverTimeMs: number): number {
    return serverTimeMs - this.offsetMs;
  }
  advance(ms: number): void {
    this.clientMs += ms;
  }
}

/** A stand-in AudioBuffer; the engines only ever hand it to the graph. */
export const fakeAudioBuffer = (durationMs: number): AudioBuffer =>
  ({ duration: durationMs / 1000, length: durationMs * 44.1, numberOfChannels: 2, sampleRate: 44_100 }) as AudioBuffer;
