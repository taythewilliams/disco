/**
 * Authentication and authorisation (D12, OWASP A01).
 *
 * Two roles, resolved once at the WebSocket upgrade and stored on the socket.
 * The credential itself never travels in a URL: it is posted to `/api/session`,
 * exchanged for a signed cookie, and the upgrade reads the cookie.
 *
 * The check that matters is `requireRole` at the top of dispatch. Hiding
 * dashboard UI is not enforcement — assume dev tools are open and
 * `{"t":"transport.skip"}` is being typed by hand.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { maySend, type ClientMessageType, type Role } from '@disco/shared';

/** A session lasts the night. Long enough that nobody is re-entering a code at 1am. */
export const SESSION_TTL_MS = 16 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'disco_session';

export interface Session {
  /** Random per session. No PII, no stable device identifier (D12). */
  clientId: string;
  role: Role;
  /** Channels this session may act on. v1 grants the DJ `["*"]` (D3). */
  channels: string[];
  expiresAt: number;
}

/**
 * Constant-time comparison that does not leak length.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing-free length oracle for anyone watching for the error. Hashing both
 * sides to a fixed width first removes the question.
 */
export function secretEquals(a: string, b: string): boolean {
  const key = 'disco-compare';
  const ha = createHmac('sha256', key).update(a).digest();
  const hb = createHmac('sha256', key).update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface Credentials {
  eventCode: string;
  djPassword: string;
  /** Absent when the event has no projector; no display session can then exist. */
  displayCode: string | null;
}

/**
 * Resolve a submitted code to a role.
 *
 * Checked most-privileged first, so an operator who sets two of these to the
 * same string gets the greater role rather than silently being demoted on their
 * own dashboard. Every comparison runs regardless of the outcome, so the answer
 * takes the same time either way.
 */
export function roleForCredential(submitted: string, credentials: Credentials): Role | null {
  const isDj = secretEquals(submitted, credentials.djPassword);
  const isDisplay =
    credentials.displayCode !== null && secretEquals(submitted, credentials.displayCode);
  const isGuest = secretEquals(submitted, credentials.eventCode);
  if (isDj) return 'dj';
  if (isDisplay) return 'display';
  if (isGuest) return 'guest';
  return null;
}

export function newClientId(): string {
  // Hex, so it satisfies `SafeId` and can be logged without escaping.
  return randomBytes(8).toString('hex');
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

function sign(payload: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

/** `<base64url payload>.<base64url hmac>`. Not a JWT: there is no algorithm field to confuse. */
export function issueSession(session: Session, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(session), 'utf8'));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token: string, secret: string, now: number): Session | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  // Verify before parsing: the payload is attacker-controlled until the HMAC
  // says otherwise, so nothing reads it first.
  if (!secretEquals(signature, sign(payload, secret))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const s = parsed as Partial<Session>;
  if (typeof s.clientId !== 'string') return null;
  if (s.role !== 'guest' && s.role !== 'dj' && s.role !== 'display') return null;
  if (!Array.isArray(s.channels) || !s.channels.every((c) => typeof c === 'string')) return null;
  if (typeof s.expiresAt !== 'number' || s.expiresAt <= now) return null;

  return { clientId: s.clientId, role: s.role, channels: s.channels, expiresAt: s.expiresAt };
}

/** The single guard every mutating handler passes through. */
export function requireRole(role: Role, type: ClientMessageType): boolean {
  return maySend(role, type);
}

/**
 * Whether a session may act on a channel. v1 issues `["*"]` to the DJ, but the
 * check is written for the scoped case now so that shipping a second channel is
 * a config change rather than an auth rewrite (D3, Part 5 Q1).
 */
export function mayActOnChannel(session: Session, channelId: string): boolean {
  return session.channels.includes('*') || session.channels.includes(channelId);
}
