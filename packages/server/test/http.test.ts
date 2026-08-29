import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../src/auth.js';
import { Comments } from '../src/comments.js';
import type { Env } from '../src/env.js';
import { DownloadGate } from '../src/downloads.js';
import { buildApp, isSegmentRequest } from '../src/http.js';
import { Hub } from '../src/hub.js';
import { silentLogger } from '../src/log.js';
import { WordFilter } from '../src/profanity.js';

const EVENT_CODE = 'DISCO24';
const DJ_PASSWORD = 'a-long-dj-password';
const DISPLAY_CODE = 'a-long-display-code';
const TRACK = 'a3a23b67f9c757b182311d64c08a5d62';
const SEGMENT_BODY = 'x'.repeat(2048);

let app: FastifyInstance;
let mediaRoot: string;
/** Kept so a test can rebuild the app around a gate it controls. */
let env: Env;
let hub: Hub;

/** The same app, with admission control a test can drive. */
const buildMetered = (gate: DownloadGate) =>
  buildApp({ env, hub, logger: silentLogger, gate });

beforeEach(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), 'disco-http-'));
  await mkdir(join(mediaRoot, 'tracks', TRACK), { recursive: true });
  await writeFile(join(mediaRoot, 'tracks', TRACK, 'init.mp4'), 'init-bytes');
  await writeFile(join(mediaRoot, 'tracks', TRACK, 'seg-00000.m4s'), SEGMENT_BODY);
  await writeFile(join(mediaRoot, 'tracks', TRACK, 'index.m3u8'), '#EXTM3U');
  await writeFile(join(mediaRoot, 'disco.db'), 'sqlite-bytes');
  await writeFile(join(mediaRoot, 'secrets.txt'), 'do not serve me');

  env = {
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
    displayCode: DISPLAY_CODE,
    sessionSecret: 's'.repeat(32),
    insecureCookies: true,
  };

  hub = new Hub({
    library: { getTrack: () => undefined, getSegments: () => [] },
    logger: silentLogger,
    comments: new Comments({ filter: new WordFilter([]) }),
    now: () => 1_000_000,
  });

  app = await buildApp({ env, hub, logger: silentLogger });
});

afterEach(async () => {
  await app.close();
  await rm(mediaRoot, { recursive: true, force: true });
});

const join_ = (code: string) =>
  app.inject({ method: 'POST', url: '/api/session', payload: { code } });

async function cookieFor(code: string): Promise<string> {
  const response = await join_(code);
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
  return `${SESSION_COOKIE}=${cookie?.value ?? ''}`;
}

describe('POST /api/session', () => {
  it('issues a guest session for the event code', async () => {
    const response = await join_(EVENT_CODE);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ role: 'guest' });
  });

  it('issues a DJ session for the DJ credential', async () => {
    expect((await join_(DJ_PASSWORD)).json()).toMatchObject({ role: 'dj' });
  });

  it('issues a read-only display session for the display code', async () => {
    expect((await join_(DISPLAY_CODE)).json()).toMatchObject({ role: 'display' });
  });

  it('sets an httpOnly, same-site cookie', async () => {
    // The credential never travels in a URL, and the cookie is not readable
    // from script — a comment field on the same origin cannot exfiltrate it.
    const cookie = (await join_(EVENT_CODE)).cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    expect(cookie?.path).toBe('/');
  });

  it('rejects a wrong code with one message for every failure', async () => {
    // Distinguishing "not the event code" from "not the DJ password" would say
    // which one a guess was close to.
    const bad = await join_('nope');
    const empty = await join_('');
    expect(bad.statusCode).toBe(401);
    expect(empty.statusCode).toBe(401);
    expect(bad.json()).toEqual(empty.json());
  });

  it('rejects a missing or non-string code', async () => {
    for (const payload of [{}, { code: 123 }, { code: null }]) {
      const response = await app.inject({ method: 'POST', url: '/api/session', payload });
      expect(response.statusCode).toBe(401);
    }
  });

  it('rate-limits guessing', async () => {
    let sawLimit = false;
    for (let i = 0; i < 30; i++) {
      if ((await join_(`guess-${i}`)).statusCode === 429) sawLimit = true;
    }
    expect(sawLimit).toBe(true);
  });
});

describe('GET /api/telemetry', () => {
  it('is refused without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/telemetry' })).statusCode).toBe(401);
  });

  it('is refused to a guest and to the display', async () => {
    // It lists every connected device's state; only the dashboard needs it.
    for (const code of [EVENT_CODE, DISPLAY_CODE]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/telemetry',
        headers: { cookie: await cookieFor(code) },
      });
      expect(response.statusCode, code).toBe(401);
    }
  });

  it('is allowed to the DJ', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/telemetry',
      headers: { cookie: await cookieFor(DJ_PASSWORD) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('clients');
  });

  it('carries readiness, download pressure and the venue on the same poll', async () => {
    // One poll, so the client count and the readiness bars can never be seen
    // disagreeing with each other (D5, D11).
    const response = await app.inject({
      method: 'GET',
      url: '/api/telemetry',
      headers: { cookie: await cookieFor(DJ_PASSWORD) },
    });
    const body = response.json() as Record<string, unknown>;
    expect(body).toHaveProperty('readiness');
    expect(body).toHaveProperty('downloads');
    expect(body['venue']).toBe('test');
  });

  it('is refused for a forged cookie', async () => {
    const forged = Buffer.from(
      JSON.stringify({ clientId: 'x', role: 'dj', channels: ['*'], expiresAt: 9e15 }),
    ).toString('base64url');
    const response = await app.inject({
      method: 'GET',
      url: '/api/telemetry',
      headers: { cookie: `${SESSION_COOKIE}=${forged}.notavalidsignature` },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('media serving', () => {
  /** Every legitimate fetch carries a session; the PWA fetches same-origin. */
  let guestCookie: string;
  beforeEach(async () => {
    guestCookie = await cookieFor(EVENT_CODE);
  });

  it('refuses media to anyone who has not passed the door', async () => {
    // The event code gates the music, not just the timeline: without this,
    // anyone associated to the venue Wi-Fi could pull the library by URL (D12).
    const response = await app.inject({
      method: 'GET',
      url: `/media/tracks/${TRACK}/seg-00000.m4s`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('serves a segment with an immutable cache header', async () => {
    // Segment URLs derive from the track's content hash, so the bytes behind
    // one can never change — this is what stops a reconnecting phone
    // re-fetching its whole buffer (D4).
    const response = await app.inject({
      method: 'GET',
      url: `/media/tracks/${TRACK}/seg-00000.m4s`,
      headers: { cookie: guestCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('immutable');
    expect(response.body).toHaveLength(2048);
  });

  it('serves the init segment', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/media/tracks/${TRACK}/init.mp4`,
      headers: { cookie: guestCookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it('supports range requests', async () => {
    // Range support is what lets a client resume a partial segment rather than
    // start it again (Part E step 3).
    const response = await app.inject({
      method: 'GET',
      url: `/media/tracks/${TRACK}/seg-00000.m4s`,
      headers: { range: 'bytes=0-99', cookie: guestCookie },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 0-99/2048');
    expect(response.body).toHaveLength(100);
  });

  it('refuses files that are not part of a track', async () => {
    for (const url of [
      `/media/tracks/${TRACK}/index.m3u8`,
      '/media/disco.db',
      '/media/secrets.txt',
      `/media/tracks/${TRACK}/`,
      '/media/tracks/',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: guestCookie } });
      expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
    }
  });

  it('refuses traversal attempts', async () => {
    for (const url of [
      '/media/tracks/../disco.db',
      '/media/tracks/../../etc/passwd',
      `/media/tracks/${TRACK}/../../../etc/passwd`,
      '/media/..%2f..%2fetc%2fpasswd',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: guestCookie } });
      expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain('sqlite-bytes');
    }
  });
});

describe('segment admission control', () => {
  it('meters audio transfers and lets the small files straight through', async () => {
    // A gate with no slots free: every audio request queues, and everything
    // else must still be served or the dashboard and the projector look broken.
    const gate = new DownloadGate({ capacity: () => 1, maxWaitMs: 50 });
    await gate.acquire('listener');

    const metered = await buildMetered(gate);
    try {
      await writeFile(join(mediaRoot, 'tracks', TRACK, 'beats.json'), '{"version":1}');
      const started = Date.now();
      const cookie = await cookieFor(EVENT_CODE);
      const small = await metered.inject({
        method: 'GET',
        url: `/media/tracks/${TRACK}/beats.json`,
        headers: { cookie },
      });
      expect(small.statusCode).toBe(200);
      // Not queued behind audio: it did not wait for the starvation valve.
      expect(Date.now() - started).toBeLessThan(50);

      const audio = await metered.inject({
        method: 'GET',
        url: `/media/tracks/${TRACK}/seg-00000.m4s`,
        headers: { cookie },
      });
      // Served in the end — the valve admits it rather than starving it (D4).
      expect(audio.statusCode).toBe(200);
      expect(gate.stats().admittedOverCapacity).toBe(1);
    } finally {
      await metered.close();
    }
  });

  it('releases its slot when the response completes', async () => {
    const gate = new DownloadGate({ capacity: () => 2 });
    const metered = await buildMetered(gate);
    try {
      const cookie = await cookieFor(EVENT_CODE);
      for (let i = 0; i < 5; i++) {
        await metered.inject({
          method: 'GET',
          url: `/media/tracks/${TRACK}/seg-00000.m4s`,
          headers: { cookie },
        });
      }
      // Five sequential transfers, never more than one at a time in flight.
      expect(gate.stats().inFlight).toBe(0);
      expect(gate.stats().peakInFlight).toBe(1);
    } finally {
      await metered.close();
    }
  });
});

describe('serving the built apps', () => {
  it('serves the PWA at the root and the dashboard under /host, /dj and /display', async () => {
    // Two Vite builds on one origin, so they need two prefixes: both emit an
    // `assets/` directory and one would shadow the other at the root.
    const guestDir = join(mediaRoot, 'guest-dist');
    const hostDir = join(mediaRoot, 'host-dist');
    await mkdir(guestDir, { recursive: true });
    await mkdir(hostDir, { recursive: true });
    await writeFile(join(guestDir, 'index.html'), '<title>guest</title>');
    await writeFile(join(guestDir, 'sw.js'), '// service worker');
    await writeFile(join(hostDir, 'index.html'), '<title>host</title>');

    const served = await buildApp({
      env: { ...env, guestDir, hostDir },
      hub,
      logger: silentLogger,
    });
    try {
      expect((await served.inject({ method: 'GET', url: '/' })).body).toContain('guest');
      for (const url of ['/host/', '/dj', '/display']) {
        const response = await served.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(200);
        expect(response.body, url).toContain('host');
      }

      // A phone holding yesterday's service worker is a phone running
      // yesterday's app (D15).
      const worker = await served.inject({ method: 'GET', url: '/sw.js' });
      expect(worker.headers['cache-control']).toBe('no-cache');

      // The API still wins over the app's catch-all.
      expect((await served.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    } finally {
      await served.close();
    }
  });
});

describe('a full download queue', () => {
  it('answers 503 with a retry hint rather than hanging', async () => {
    const gate = new DownloadGate({ capacity: () => 1, maxWaitMs: 60_000, maxQueued: 0 });
    await gate.acquire('listener');
    const metered = await buildMetered(gate);
    try {
      const cookie = await cookieFor(EVENT_CODE);
      const response = await metered.inject({
        method: 'GET',
        url: `/media/tracks/${TRACK}/seg-00000.m4s`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
    } finally {
      await metered.close();
    }
  });
});

describe('classifying a request', () => {
  it('meters fragments and init segments only', () => {
    expect(isSegmentRequest(`/media/tracks/${TRACK}/seg-00000.m4s`)).toBe(true);
    expect(isSegmentRequest(`/media/tracks/${TRACK}/init.mp4`)).toBe(true);
    expect(isSegmentRequest(`/media/tracks/${TRACK}/seg-00000.m4s?v=2`)).toBe(true);
    // Kilobyte files the dashboard and the projector need promptly.
    expect(isSegmentRequest(`/media/tracks/${TRACK}/beats.json`)).toBe(false);
    expect(isSegmentRequest(`/media/tracks/${TRACK}/art-256.jpg`)).toBe(false);
    expect(isSegmentRequest('/api/telemetry')).toBe(false);
  });
});

describe('GET /selfcheck', () => {
  it('serves the page, its script and its worker without a session', async () => {
    // It has to work before the app does: putting "why will this phone not
    // load the app?" behind the event code hides the diagnosis behind the
    // thing being diagnosed (D14, Spike 4).
    for (const [url, type] of [
      ['/selfcheck', 'text/html'],
      ['/selfcheck.js', 'application/javascript'],
      ['/selfcheck-sw.js', 'application/javascript'],
    ]) {
      const response = await app.inject({ method: 'GET', url: url as string });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type'], url).toContain(type as string);
      expect(response.headers['cache-control'], url).toBe('no-store');
    }
  });

  it('keeps the probe worker to its own scope', async () => {
    // A wider scope would shadow the PWA's own service worker at `/` (D15).
    const response = await app.inject({ method: 'GET', url: '/selfcheck-sw.js' });
    expect(response.headers['service-worker-allowed']).toBe('/selfcheck');
  });

  it('carries no inline script, because the venue CSP forbids it', async () => {
    const response = await app.inject({ method: 'GET', url: '/selfcheck' });
    expect(response.body).toContain('<script src="/selfcheck.js"></script>');
    expect(response.body).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });
});

describe('GET /api/health', () => {
  it('reports liveness and the server clock', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, connections: 0 });
  });
});
