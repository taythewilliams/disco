import { describe, expect, it } from 'vitest';
import {
  SESSION_TTL_MS,
  issueSession,
  mayActOnChannel,
  newClientId,
  requireRole,
  roleForCredential,
  secretEquals,
  verifySession,
  type Session,
} from '../src/auth.js';

const SECRET = 'a'.repeat(32);
const NOW = 1_724_832_000_000;

const session = (over: Partial<Session> = {}): Session => ({
  clientId: 'ab12cd34',
  role: 'guest',
  channels: ['*'],
  expiresAt: NOW + SESSION_TTL_MS,
  ...over,
});

describe('secretEquals', () => {
  it('compares equal and unequal secrets', () => {
    expect(secretEquals('hunter2', 'hunter2')).toBe(true);
    expect(secretEquals('hunter2', 'hunter3')).toBe(false);
  });

  it('handles differing lengths without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, which would itself leak
    // length through the error path. Hashing first removes the question.
    expect(secretEquals('short', 'considerably longer')).toBe(false);
    expect(secretEquals('', '')).toBe(true);
  });
});

describe('roleForCredential', () => {
  const CREDENTIALS = {
    eventCode: 'DISCO24',
    djPassword: 'a-long-dj-password',
    displayCode: 'a-long-display-code',
  };

  it('resolves each credential to its role', () => {
    expect(roleForCredential(CREDENTIALS.eventCode, CREDENTIALS)).toBe('guest');
    expect(roleForCredential(CREDENTIALS.djPassword, CREDENTIALS)).toBe('dj');
    expect(roleForCredential(CREDENTIALS.displayCode, CREDENTIALS)).toBe('display');
  });

  it('rejects anything else', () => {
    for (const attempt of ['', 'disco24', 'DISCO24 ', 'a-long-display-cod']) {
      expect(roleForCredential(attempt, CREDENTIALS)).toBeNull();
    }
  });

  it('has no display role at all when no display code is set', () => {
    // The right default for an event without a projector: not a weak code, no
    // code (D8).
    const noDisplay = { ...CREDENTIALS, displayCode: null };
    expect(roleForCredential(CREDENTIALS.displayCode, noDisplay)).toBeNull();
    expect(roleForCredential('', noDisplay)).toBeNull();
  });

  it('prefers the greater role if two credentials are set the same', () => {
    // An operator who reuses one string should not be silently demoted on their
    // own dashboard.
    expect(roleForCredential('same', { eventCode: 'same', djPassword: 'same', displayCode: 'same' })).toBe('dj');
    expect(
      roleForCredential('same', { eventCode: 'same', djPassword: 'other', displayCode: 'same' }),
    ).toBe('display');
  });
});

describe('sessions', () => {
  it('round-trips', () => {
    const s = session();
    expect(verifySession(issueSession(s, SECRET), SECRET, NOW)).toEqual(s);
  });

  it('rejects a tampered payload', () => {
    // The whole point: a client that edits its own role must fail the HMAC.
    const token = issueSession(session({ role: 'guest' }), SECRET);
    const [payload, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify(session({ role: 'dj' })),
      'utf8',
    ).toString('base64url');

    expect(verifySession(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
    expect(payload).not.toBe(forged);
  });

  it('rejects a tampered signature', () => {
    const token = issueSession(session(), SECRET);
    expect(verifySession(`${token}x`, SECRET, NOW)).toBeNull();
  });

  it('rejects a token signed with another key', () => {
    const token = issueSession(session(), 'b'.repeat(32));
    expect(verifySession(token, SECRET, NOW)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = issueSession(session({ expiresAt: NOW - 1 }), SECRET);
    expect(verifySession(token, SECRET, NOW)).toBeNull();
  });

  it('rejects malformed tokens without throwing', () => {
    for (const bad of ['', '.', 'nodot', 'a.b', '.sig', Buffer.from('{}').toString('base64url')]) {
      expect(verifySession(bad, SECRET, NOW)).toBeNull();
    }
  });

  it('rejects a validly signed token carrying an unknown role', () => {
    // Signed by us, so the HMAC passes — the shape check is what stops it.
    const payload = Buffer.from(
      JSON.stringify({ ...session(), role: 'admin' }),
      'utf8',
    ).toString('base64url');
    const token = issueSession({ ...session(), role: 'guest' }, SECRET);
    const signature = token.split('.')[1] as string;
    expect(verifySession(`${payload}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it('issues distinct client IDs with no PII in them', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newClientId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('requireRole', () => {
  const MUTATING = [
    'queue.set',
    'transport.play',
    'transport.pause',
    'transport.skip',
    'transport.seek',
    'comment.approve',
    'comment.reject',
    'comment.remove',
    'feed.hide',
    'config.set',
    'resync',
  ] as const;

  it('lets a guest do exactly what a guest may do', () => {
    for (const type of ['ping', 'subscribe', 'telemetry', 'comment'] as const) {
      expect(requireRole('guest', type)).toBe(true);
    }
  });

  it('refuses every mutating message from a guest', () => {
    for (const type of MUTATING) {
      expect(requireRole('guest', type)).toBe(false);
      expect(requireRole('dj', type)).toBe(true);
    }
  });

  it('refuses every mutating message from the display', () => {
    // The projector is a screen in a public room. It reads and renders; it
    // cannot skip a track (D8).
    for (const type of MUTATING) expect(requireRole('display', type)).toBe(false);
    expect(requireRole('display', 'subscribe')).toBe(true);
    expect(requireRole('display', 'comment')).toBe(false);
  });
});

describe('mayActOnChannel', () => {
  it('accepts the v1 wildcard', () => {
    expect(mayActOnChannel(session({ channels: ['*'] }), 'anything')).toBe(true);
  });

  it('enforces a scoped grant', () => {
    const scoped = session({ role: 'dj', channels: ['main', 'chill'] });
    expect(mayActOnChannel(scoped, 'main')).toBe(true);
    expect(mayActOnChannel(scoped, 'chill')).toBe(true);
    expect(mayActOnChannel(scoped, 'other')).toBe(false);
  });

  it('refuses everything for an empty grant', () => {
    expect(mayActOnChannel(session({ channels: [] }), 'main')).toBe(false);
  });
});
