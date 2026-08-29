/**
 * Runtime environment (D12).
 *
 * Every secret comes from the environment and none has a default — a server
 * that boots with a guessable event code because the operator forgot a variable
 * is worse than one that refuses to boot. Load them with Node's own
 * `--env-file=.env`; there is no dotenv dependency.
 */

import { resolve } from 'node:path';

export interface Env {
  host: string;
  port: number;
  mediaRoot: string;
  /**
   * Which venue profile to load. Projector lag varies by unit and by room, so
   * the offset measured at one venue is worthless at the next (D8).
   */
  venue: string;
  /** Where that profile lives. Defaults to a file beside the manifest. */
  venueFile: string;
  /**
   * Built PWA and dashboard, served by this process in production.
   *
   * Absent in development, where Vite serves them on their own ports and
   * proxies here — so a missing directory is normal and not an error.
   */
  guestDir: string;
  hostDir: string;
  /** Gates the guest role. Printed on the QR poster, not a secret from guests. */
  eventCode: string;
  /** Gates the DJ role. A real secret. */
  djPassword: string;
  /**
   * Gates the read-only projector role. Optional: leave it unset and no display
   * session can be created at all, which is the right default for an event
   * without a projector (D8).
   */
  displayCode: string | null;
  /** HMAC key for session cookies. Rotating it logs everyone out, nothing more. */
  sessionSecret: string;
  /** Serve without TLS-only cookies. Local development only. */
  insecureCookies: boolean;
  /**
   * Per-IP cap on `/api/session` attempts. Raise it only to run the
   * virtual-client harness, which opens many sessions from one address.
   */
  joinAttemptsPerMinute?: number;
}

class EnvError extends Error {}

function required(source: NodeJS.ProcessEnv, name: string, minLength: number): string {
  const value = source[name];
  if (!value || value.length < minLength) {
    throw new EnvError(`${name} must be set and at least ${minLength} characters`);
  }
  return value;
}

/**
 * A secret that may be absent, but not present-and-weak.
 *
 * Silently accepting a four-character display code because the variable was
 * "optional" would be the worst of both.
 */
function optional(source: NodeJS.ProcessEnv, name: string, minLength: number): string | null {
  const value = source[name];
  if (value === undefined || value === '') return null;
  if (value.length < minLength) {
    throw new EnvError(`${name} is set but shorter than ${minLength} characters`);
  }
  return value;
}

/** Bounded on both sides: a typo must not disable the limit or make it useless. */
function clampAttempts(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new EnvError('DISCO_JOIN_ATTEMPTS_PER_MINUTE must be a positive integer');
  }
  return Math.min(value, 1_000);
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const port = Number(source['DISCO_PORT'] ?? 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    // Above 1024 so the process never needs root to bind. Caddy owns 443 and
    // proxies here (D12, D14).
    throw new EnvError('DISCO_PORT must be an unprivileged port between 1024 and 65535');
  }

  const mediaRoot = resolve(source['DISCO_MEDIA_ROOT'] ?? 'media');
  // A venue name reaches a filename. Narrow charset, not sanitisation after the
  // fact — the operator sets this, but a path separator here would be a
  // traversal in an operational file rather than an obvious mistake.
  const venue = (source['DISCO_VENUE'] ?? 'default').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(venue)) {
    throw new EnvError('DISCO_VENUE must be 1–64 characters of [A-Za-z0-9_-]');
  }

  return {
    // Loopback by default: Caddy terminates TLS and proxies, so the app has no
    // reason to be reachable on the LAN directly. Set DISCO_HOST explicitly to
    // widen it.
    host: source['DISCO_HOST'] ?? '127.0.0.1',
    port,
    mediaRoot,
    venue,
    venueFile: resolve(source['DISCO_VENUE_FILE'] ?? `${mediaRoot}/venue-${venue}.json`),
    guestDir: resolve(source['DISCO_GUEST_DIR'] ?? 'apps/guest/dist'),
    hostDir: resolve(source['DISCO_HOST_DIR'] ?? 'apps/host/dist'),
    eventCode: required(source, 'DISCO_EVENT_CODE', 4),
    djPassword: required(source, 'DISCO_DJ_PASSWORD', 12),
    displayCode: optional(source, 'DISCO_DISPLAY_CODE', 12),
    sessionSecret: required(source, 'DISCO_SESSION_SECRET', 32),
    insecureCookies: source['DISCO_INSECURE_COOKIES'] === '1',
    ...(source['DISCO_JOIN_ATTEMPTS_PER_MINUTE']
      ? { joinAttemptsPerMinute: clampAttempts(source['DISCO_JOIN_ATTEMPTS_PER_MINUTE']) }
      : {}),
  };
}
