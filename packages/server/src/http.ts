/**
 * The Fastify app: session exchange, media serving, WebSocket upgrade.
 *
 * TLS is Caddy's job (D14). This process listens on an unprivileged port,
 * usually on loopback, and never handles a certificate.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { CLOSE_UNAUTHORISED, DEFAULT_CHANNEL_ID, serverNow } from '@disco/shared';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  issueSession,
  newClientId,
  roleForCredential,
  verifySession,
  type Session,
} from './auth.js';
import { DownloadGate, DownloadQueueFull } from './downloads.js';
import type { Env } from './env.js';
import { Hub } from './hub.js';
import type { Logger } from './log.js';
import { IMMUTABLE_CACHE_CONTROL, isAllowedTrackFile } from './media.js';
import {
  SELFCHECK_HTML,
  SELFCHECK_JS,
  SELFCHECK_SCOPE,
  SELFCHECK_SW,
} from './selfcheck.js';
import { TokenBucket } from './ratelimit.js';

export interface AppDeps {
  env: Env;
  hub: Hub;
  logger: Logger;
  /** Supplied by tests that want to drive or inspect admission control. */
  gate?: DownloadGate;
}

/**
 * Guards the event code against being guessed, per source address.
 *
 * Per-IP is the right unit at the venue — every phone has its own DHCP lease —
 * but it is the wrong unit for the virtual-client harness, which opens thirty
 * sessions from one address on purpose. Hence `DISCO_JOIN_ATTEMPTS_PER_MINUTE`:
 * raising it is a deliberate act for a load test, not a default.
 */
const DEFAULT_JOIN_ATTEMPTS_PER_MINUTE = 20;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env, hub, logger } = deps;

  const app = Fastify({
    // Fastify's own logger is off: logging goes through one place that knows
    // which fields must never be written (D12).
    logger: false,
    // Trust exactly one hop, and only from loopback — Caddy runs on the same
    // box. `trustProxy: true` would take the leftmost `X-Forwarded-For` value,
    // which is client-controlled: a guest could then forge a fresh address per
    // request and walk straight through the per-IP limit on the event code.
    trustProxy: ['127.0.0.1', '::1'],
    bodyLimit: 4 * 1024,
  });

  await app.register(cookie);
  await app.register(websocket);

  await app.register(staticPlugin, {
    root: env.mediaRoot,
    prefix: '/media/',
    index: false,
    // Second gate. `@fastify/static` confines to root on its own; this narrows
    // it to the six kinds of file a track directory actually holds, so a stray
    // file in `media/` is not silently public (D12).
    allowedPath: (pathName) => {
      const parts = pathName.split('/').filter(Boolean);
      if (parts.length !== 3) return false;
      const [dir, trackId, file] = parts as [string, string, string];
      return dir === 'tracks' && /^[A-Za-z0-9_-]{1,64}$/.test(trackId) && isAllowedTrackFile(file);
    },
    // Off, so `setHeaders` below owns the header outright. Left on, the
    // plugin's own `max-age=0` is applied afterwards and silently wins.
    cacheControl: false,
    setHeaders: (reply) => {
      // Segment paths are derived from the track's content hash, so the bytes
      // behind a URL can never change. This is what stops a reconnecting phone
      // re-fetching its buffer (D4).
      reply.header('cache-control', IMMUTABLE_CACHE_CONTROL);
    },
  });

  /**
   * The built PWA and dashboard, when they exist.
   *
   * In development Vite serves both on their own ports and proxies here, so a
   * missing `dist` is the normal case and not a failure. The dashboard lives
   * under `/host/` because both apps are Vite builds with an `assets/`
   * directory, and two apps at one origin need two prefixes.
   */
  if (existsSync(env.hostDir)) {
    await app.register(staticPlugin, {
      root: env.hostDir,
      prefix: '/host/',
      index: ['index.html'],
      decorateReply: false,
    });

    // Two friendly routes onto the same bundle. `/display` is the one that gets
    // typed into a browser on a projector-connected machine at setup (D8).
    //
    // Read and sent rather than handed to `sendFile`: the decorated helper
    // belongs to the media registration and carries its allowlist, which quite
    // correctly refuses anything that is not a track file.
    const indexPath = join(env.hostDir, 'index.html');
    for (const route of ['/dj', '/display']) {
      app.get(route, async (_request, reply) => {
        const html = await readFile(indexPath, 'utf8');
        // Never cached: the app behind it changes with every build, and the
        // hashed assets it references carry their own caching.
        return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html);
      });
    }
  }

  if (existsSync(env.guestDir)) {
    await app.register(staticPlugin, {
      root: env.guestDir,
      prefix: '/',
      index: ['index.html'],
      decorateReply: false,
      // The service worker and the manifest must never be served stale: a phone
      // holding yesterday's `sw.js` is a phone running yesterday's app (D15).
      setHeaders: (reply, path) => {
        if (/(?:sw\.js|manifest\.webmanifest|index\.html)$/.test(path)) {
          reply.header('cache-control', 'no-cache');
        }
      },
    });
  }

  /**
   * Segment admission control (D4).
   *
   * A slot is taken before the file is opened and released when the response
   * completes, so the cap counts transfers in flight rather than requests
   * accepted. Listeners outrank joiners: a rush at the door must not starve the
   * dance floor.
   */
  const gate =
    deps.gate ?? new DownloadGate({ capacity: () => hub.config.maxConcurrentSegmentDownloads });
  const releases = new WeakMap<FastifyRequest, () => void>();

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/media/')) return;

    const session = sessionFrom(request.cookies[SESSION_COOKIE], env.sessionSecret);
    // The event code gates the music, not just the timeline. Without this,
    // anyone associated to the venue Wi-Fi could pull the whole library by URL
    // without ever passing the door (D12). Every legitimate fetch already
    // carries the cookie: the PWA fetches same-origin, and so does the harness.
    if (!session) {
      return reply.code(401).send({ error: 'Not allowed.' });
    }

    if (!isSegmentRequest(request.url)) return;
    const listening = hub.isListening(session.clientId);
    try {
      releases.set(request, await gate.acquire(listening ? 'listener' : 'joiner'));
    } catch (err) {
      if (!(err instanceof DownloadQueueFull)) throw err;
      // Refused rather than queued indefinitely. The client's prefetch loop
      // retries on its next tick, which is a quarter of a second away.
      logger.event('warn', 'media.queue-full', { clientId: session.clientId });
      return reply.code(503).header('retry-after', '1').send({ error: 'Busy. Try again.' });
    }
  });

  // Both hooks fire for the same request in some failure paths; the release
  // function is idempotent, which is why it can be called from both.
  app.addHook('onResponse', async (request) => releases.get(request)?.());
  app.addHook('onRequestAbort', async (request) => releases.get(request)?.());

  const joinLimits = new Map<string, TokenBucket>();
  const joinAttemptsPerMinute = env.joinAttemptsPerMinute ?? DEFAULT_JOIN_ATTEMPTS_PER_MINUTE;

  /**
   * Exchange a code for a session cookie.
   *
   * The credential is posted, never put in a URL: query strings end up in proxy
   * logs, browser history and `Referer` headers. The QR poster carries the code
   * so the page can prefill it, but the page posts it from there.
   */
  app.post('/api/session', async (request, reply) => {
    const address = request.ip;
    const now = Date.now();
    let bucket = joinLimits.get(address);
    if (!bucket) {
      bucket = new TokenBucket(joinAttemptsPerMinute, joinAttemptsPerMinute, now);
      joinLimits.set(address, bucket);
    }
    if (!bucket.take(now)) {
      logger.event('warn', 'session.rate-limited', { ip: address });
      return reply.code(429).send({ error: 'Too many attempts. Wait a minute.' });
    }

    const body = request.body as { code?: unknown } | undefined;
    const submitted = typeof body?.code === 'string' ? body.code : '';
    const role = submitted
      ? roleForCredential(submitted, {
          eventCode: env.eventCode,
          djPassword: env.djPassword,
          displayCode: env.displayCode,
        })
      : null;

    if (!role) {
      // One message for both wrong-code cases: distinguishing them would say
      // whether a guess was close to the DJ credential or the event code.
      logger.event('warn', 'session.rejected', { ip: address });
      return reply.code(401).send({ error: 'That code did not work.' });
    }

    const session: Session = {
      clientId: newClientId(),
      role,
      // v1 grants everything to everyone; the field exists so per-channel
      // scoping is a config change rather than an auth rewrite (D3). Scope
      // still buys nothing for a guest or a display — neither can mutate.
      channels: ['*'],
      expiresAt: now + SESSION_TTL_MS,
    };

    logger.event('info', 'session.issued', { clientId: session.clientId, role });

    return reply
      .setCookie(SESSION_COOKIE, issueSession(session, env.sessionSecret), {
        httpOnly: true,
        sameSite: 'strict',
        // Off only for local development; a session cookie on a plaintext
        // origin is a session cookie on the venue Wi-Fi.
        secure: !env.insecureCookies,
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      })
      .send({ role, clientId: session.clientId });
  });

  /**
   * Spike 4's pass criteria, as a page a phone can load (D14).
   *
   * Unauthenticated on purpose: it carries no data, and putting "why will this
   * phone not load the app?" behind the event code would hide the diagnosis
   * behind the thing being diagnosed. Served from three routes rather than one
   * inline blob because the venue's CSP is `script-src 'self'`.
   */
  app.get('/selfcheck', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(SELFCHECK_HTML),
  );
  app.get('/selfcheck.js', async (_request, reply) =>
    reply
      .type('application/javascript; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(SELFCHECK_JS),
  );
  app.get('/selfcheck-sw.js', async (_request, reply) =>
    reply
      .type('application/javascript; charset=utf-8')
      // A cached service worker script is a service worker you cannot change.
      .header('cache-control', 'no-store')
      // The script sits at the root, so it may claim any scope at or below it;
      // the page asks for `/selfcheck` and nothing wider (D15).
      .header('service-worker-allowed', SELFCHECK_SCOPE)
      .send(SELFCHECK_SW),
  );

  /**
   * The role this browser already holds, if any.
   *
   * Both the dashboard and the projector ask on load so a reload mid-set does
   * not become a credential prompt — which, on a projector, would mean a
   * sign-in form on a wall in front of a room. It reveals only what the caller
   * already has: its own role and its own random client ID.
   */
  app.get('/api/session', async (request, reply) => {
    const session = sessionFrom(request.cookies[SESSION_COOKIE], env.sessionSecret);
    if (!session) return reply.code(401).send({ error: 'Not signed in.' });
    return { role: session.role, clientId: session.clientId };
  });

  app.get('/api/health', async () => ({
    ok: true,
    serverTime: serverNow(),
    connections: hub.connections.size,
  }));

  /**
   * The library, for the dashboard's track list. DJ only: the catalogue is not
   * something a guest device needs, and not sending it is one less thing to
   * leak.
   */
  app.get('/api/library', async (request, reply) => {
    const session = sessionFrom(request.cookies[SESSION_COOKIE], env.sessionSecret);
    if (session?.role !== 'dj') return reply.code(401).send({ error: 'Not allowed.' });

    const query = request.query as {
      q?: string;
      limit?: string;
      offset?: string;
      sort?: string;
    };
    return hub.listLibrary({
      // Bounded before it reaches SQL. A caller-supplied limit is a resource
      // control, not a suggestion.
      ...(query.q ? { q: query.q.slice(0, 100) } : {}),
      limit: clampInt(query.limit, 100, 1, 500),
      offset: clampInt(query.offset, 0, 0, 1_000_000),
      sort: trackSort(query.sort),
    });
  });

  /**
   * Dashboard telemetry panel (D11). DJ only — it lists every guest's state.
   *
   * Readiness rides along with it rather than sitting on its own endpoint: the
   * dashboard wants both on the same poll, and two polls would show the client
   * count and the readiness bars disagreeing every other second.
   */
  app.get('/api/telemetry', async (request, reply) => {
    const session = sessionFrom(request.cookies[SESSION_COOKIE], env.sessionSecret);
    if (session?.role !== 'dj') return reply.code(401).send({ error: 'Not allowed.' });
    const query = request.query as { channelId?: string };
    const channelId =
      query.channelId && hub.channels.has(query.channelId) ? query.channelId : DEFAULT_CHANNEL_ID;
    return {
      clients: hub.telemetrySnapshot(),
      readiness: hub.readinessSnapshot(channelId),
      downloads: gate.stats(),
      venue: env.venue,
    };
  });

  app.get('/ws', { websocket: true }, (socket, request) => {
    const session = sessionFrom(request.cookies[SESSION_COOKIE], env.sessionSecret);
    if (!session) {
      // Application-level unauthorised, resolved here at the upgrade and stored
      // on the connection — never re-derived from client claims. The code is
      // shared so the client can tell "refused" from "network dropped" and stop
      // retrying something a retry cannot fix.
      socket.close(CLOSE_UNAUTHORISED, 'unauthorised');
      return;
    }

    const connection = hub.connect(session, {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
    });

    socket.on('message', (raw: Buffer | string) => {
      hub.handleRaw(connection, typeof raw === 'string' ? raw : raw.toString('utf8'));
    });
    socket.on('close', () => hub.disconnect(connection));
    socket.on('error', () => hub.disconnect(connection));
  });

  app.setErrorHandler((error, request, reply) => {
    const id = randomUUID().slice(0, 8);
    // The reference goes to the client, the detail stays in the log. An error
    // body is not a place to describe internals.
    logger.event('error', 'http.error', {
      ref: id,
      route: request.url,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    reply.code(500).send({ error: 'Something went wrong.', ref: id });
  });

  return app;
}

function sessionFrom(token: string | undefined, secret: string): Session | null {
  if (!token) return null;
  return verifySession(token, secret, Date.now());
}

/**
 * Whether a URL is an audio transfer worth metering.
 *
 * Only the big files: fragments and the initialisation segment. Peaks, beats
 * and artwork are kilobytes and queueing them behind audio would make the
 * dashboard and the projector feel broken for no bandwidth saved.
 */
export function isSegmentRequest(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (!path.startsWith('/media/tracks/')) return false;
  return path.endsWith('.m4s') || path.endsWith('/init.mp4');
}

/** Sort keys the library list offers. Anything else falls back to the default. */
function trackSort(raw: string | undefined): 'artist' | 'title' | 'bpm' | 'recent' {
  return raw === 'title' || raw === 'bpm' || raw === 'recent' ? raw : 'artist';
}

/** Parse a query-string integer, falling back rather than trusting it. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
