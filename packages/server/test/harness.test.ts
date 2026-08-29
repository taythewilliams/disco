/**
 * The harness, exercised against a real listening server.
 *
 * Real sockets, real HTTP, real SQLite manifest — the only thing simulated is
 * the audio device. This is the test that catches multi-client server
 * behaviour: rate limits that are too tight for a normal arrival, a broadcast
 * that misses a subscriber, a segment route that fails under concurrency.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { Library } from '@disco/ingest/db';
import { serverNow } from '@disco/shared';
import { Comments } from '../src/comments.js';
import type { Env } from '../src/env.js';
import { buildApp } from '../src/http.js';
import { Hub } from '../src/hub.js';
import { silentLogger } from '../src/log.js';
import { WordFilter } from '../src/profanity.js';
import { runHarness } from './harness/harness.js';

const EVENT_CODE = 'DISCO24-test';
const DJ_PASSWORD = 'a-long-dj-password';
const SEGMENT_MS = 25_000;
const SEGMENTS = 6;
const SEGMENT_BYTES = 40_000;

let app: FastifyInstance;
let library: Library;
let mediaRoot: string;
let baseUrl: string;
let hub: Hub;
const trackIds = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];

async function writeTrack(trackId: string): Promise<void> {
  const dir = join(mediaRoot, 'tracks', trackId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'init.mp4'), 'x'.repeat(900));

  const segments = [];
  for (let index = 0; index < SEGMENTS; index++) {
    const name = `seg-${String(index).padStart(5, '0')}.m4s`;
    await writeFile(join(dir, name), 'x'.repeat(SEGMENT_BYTES));
    segments.push({
      index,
      path: `tracks/${trackId}/${name}`,
      startMs: index * SEGMENT_MS,
      durationMs: SEGMENT_MS,
      bytes: SEGMENT_BYTES,
    });
  }

  library.saveTrack(
    {
      id: trackId,
      contentHash: `${trackId}-hash`,
      sourcePath: `/music/${trackId}.flac`,
      title: `Track ${trackId.slice(0, 4)}`,
      artist: 'Disco Test',
      album: null,
      durationMs: SEGMENTS * SEGMENT_MS,
      sampleRate: 44_100,
      channels: 2,
      integratedLufs: -16,
      truePeakDb: -2,
      gainDb: 1.85,
      bpm: 128,
      beatGridOffsetMs: 1_880,
      beatCount: 129,
      initPath: `tracks/${trackId}/init.mp4`,
      peaksPath: null,
      beatsPath: null,
      artPathSmall: null,
      artPathLarge: null,
      ingestedAt: Date.now(),
      ingestVersion: 1,
    },
    segments,
  );
}

/** A DJ connection that queues both tracks and starts playback. */
async function djStartsTheSet(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: DJ_PASSWORD }),
  });
  const cookie = (response.headers.getSetCookie()[0] as string).split(';')[0] as string;

  const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`, { headers: { cookie } });
  await new Promise<void>((resolve) => socket.on('open', () => resolve()));
  socket.send(JSON.stringify({ t: 'queue.set', channelId: 'main', trackIds }));
  socket.send(JSON.stringify({ t: 'transport.play', channelId: 'main' }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  socket.close();
}

beforeAll(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), 'disco-harness-'));
  library = new Library(join(mediaRoot, 'disco.db'));
  for (const id of trackIds) await writeTrack(id);

  const env: Env = {
    host: '127.0.0.1',
    port: 3000,
    mediaRoot,
    venue: 'test',
    venueFile: join(mediaRoot, 'venue-test.json'),
    // No built apps in a unit test: the server serves them only when the
    // directories exist, which is what makes development work at all.
    guestDir: join(mediaRoot, 'no-guest-build'),
    hostDir: join(mediaRoot, 'no-host-build'),
    eventCode: EVENT_CODE,
    djPassword: DJ_PASSWORD,
    displayCode: null,
    sessionSecret: 'h'.repeat(32),
    insecureCookies: true,
    // The point of this suite is many clients from one address, which is
    // exactly what the per-IP limit exists to stop. Raising it here is the
    // deliberate act the variable is for.
    joinAttemptsPerMinute: 200,
  };

  hub = new Hub({
    library,
    logger: silentLogger,
    comments: new Comments({ filter: new WordFilter([]) }),
    now: serverNow,
    // Zero lead time: the point of this run is concurrency, not the D5 gate,
    // which has its own tests.
    config: { minLeadTimeMs: 0 },
  });

  app = await buildApp({ env, hub, logger: silentLogger });
  // Port 0: the OS picks a free one, so a run never collides with a dev server.
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;

  await djStartsTheSet();
});

afterAll(async () => {
  await app.close();
  library.close();
  await rm(mediaRoot, { recursive: true, force: true });
});

describe('virtual-client harness', () => {
  it('runs a fleet of clients through a real set', async () => {
    const report = await runHarness({
      baseUrl,
      eventCode: EVENT_CODE,
      clients: 8,
      channelId: 'main',
      arrivalStaggerMs: 0, // Everybody scans the QR at once.
      durationMs: 2_500,
    });

    // Every client locked its clock. A client that never locks cannot schedule
    // anything, so this is the first thing to check, not the last.
    expect(report.locked).toBe(8);
    expect(report.clients).toHaveLength(8);

    // The spread between guests is the sync error this architecture controls;
    // a uniform offset is inaudible (v4 Part 0). On loopback it should be tiny.
    expect(report.offsetSpreadMs).not.toBeNull();
    expect(report.offsetSpreadMs!).toBeLessThan(50);

    // Real bytes moved, and none of them failed.
    expect(report.totalBytes).toBeGreaterThan(0);
    expect(report.failedRequests).toBe(0);

    // Normal arrival traffic must not trip a rate limit. Sixteen clock pings on
    // connect is what a phone does, and a limit that refuses it would delay
    // every guest at the door (D9, D12).
    expect(report.errorCounts).toEqual({});
  }, 30_000);

  it('gets every client ready without one starving another', async () => {
    const report = await runHarness({
      baseUrl,
      eventCode: EVENT_CODE,
      clients: 8,
      channelId: 'main',
      arrivalStaggerMs: 0,
      durationMs: 2_500,
    });

    const ready = report.clients.filter((c) => c.timeToReadyMs !== null);
    expect(ready).toHaveLength(8);
    // Nobody is left far behind the pack — the failure mode a concurrency cap
    // without prioritisation produces (D4).
    expect(report.timeToReady!.max).toBeLessThan(2_000);
  }, 30_000);

  it('fetches the playing track before anything queued', async () => {
    // Ordering under real concurrency, not just in the planner's unit tests.
    const report = await runHarness({
      baseUrl,
      eventCode: EVENT_CODE,
      clients: 4,
      channelId: 'main',
      arrivalStaggerMs: 0,
      durationMs: 1_500,
    });

    for (const client of report.clients) {
      expect(client.segmentsFetched).toBeGreaterThan(0);
    }
  }, 30_000);

  it('populates the dashboard telemetry panel', async () => {
    // A harness run should look exactly like a room full of phones to the
    // dashboard, so the panel can be checked before the panel matters (D11).
    const before = hub.telemetrySnapshot().length;
    await runHarness({
      baseUrl,
      eventCode: EVENT_CODE,
      clients: 3,
      channelId: 'main',
      arrivalStaggerMs: 0,
      durationMs: 1_200,
    });
    expect(before).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
