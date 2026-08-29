import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ROLES,
  ClientMessage,
  RuntimeConfigPatch,
  SafeId,
  ServerMessage,
  StateMsg,
  mayReadFeed,
  maySend,
  parseClientMessage,
  type ClientMessageType,
} from '../src/protocol.js';
import { DEFAULT_RUNTIME_CONFIG } from '../src/constants.js';

describe('SafeId', () => {
  it('accepts ordinary identifiers', () => {
    for (const id of ['main', 'abc123', 'a_b-c', 'A'.repeat(64)]) {
      expect(SafeId.safeParse(id).success).toBe(true);
    }
  });

  it('rejects anything that could reach outside the media directory', () => {
    // The schema is the first of two traversal gates; the second is the resolved
    // path check at the point of use (D12).
    for (const id of ['../etc/passwd', 'a/b', 'a\\b', '..', 'a.mp4', 'a%2fb', '', 'a'.repeat(65)]) {
      expect(SafeId.safeParse(id).success).toBe(false);
    }
  });
});

describe('parseClientMessage', () => {
  it('accepts a well-formed ping', () => {
    const r = parseClientMessage(JSON.stringify({ t: 'ping', t0: 12.5 }));
    expect(r).toEqual({ ok: true, value: { t: 'ping', t0: 12.5 } });
  });

  it('rejects malformed JSON', () => {
    const r = parseClientMessage('{not json');
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown message type rather than ignoring it', () => {
    // Ignoring means never counting it. Every rejection is a log line.
    const r = parseClientMessage(JSON.stringify({ t: 'transport.nuke', channelId: 'main' }));
    expect(r).toMatchObject({ ok: false, code: 'bad-message' });
  });

  it('rejects a known type with a missing field', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'subscribe' })).ok).toBe(false);
  });

  it('rejects a traversal attempt in a track ID', () => {
    const raw = JSON.stringify({ t: 'queue.set', channelId: 'main', trackIds: ['../../etc/passwd'] });
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it('rejects a non-object payload', () => {
    for (const raw of ['null', '42', '"ping"', '[]']) {
      expect(parseClientMessage(raw).ok).toBe(false);
    }
  });
});

describe('authorisation table', () => {
  const MUTATING: ClientMessageType[] = [
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
  ];

  it('covers every client message type', () => {
    const declared = Object.keys(ALLOWED_ROLES).sort();
    const actual = ClientMessage.options.map((o) => o.shape.t.value as ClientMessageType).sort();
    expect(declared).toEqual(actual);
  });

  it('grants every mutating message to the DJ alone', () => {
    for (const type of MUTATING) {
      expect(ALLOWED_ROLES[type], type).toEqual(['dj']);
    }
  });

  it('lets a guest do exactly four things', () => {
    expect(maySend('guest', 'ping')).toBe(true);
    expect(maySend('guest', 'subscribe')).toBe(true);
    expect(maySend('guest', 'telemetry')).toBe(true);
    expect(maySend('guest', 'comment')).toBe(true);
    for (const type of MUTATING) expect(maySend('guest', type), type).toBe(false);
  });

  it('makes the display strictly read-only', () => {
    // It is a screen in a public room. It reads the timeline and the moderated
    // feed and can change nothing — not even skip a track (D8).
    expect(maySend('display', 'subscribe')).toBe(true);
    expect(maySend('display', 'ping')).toBe(true);
    for (const type of MUTATING) expect(maySend('display', type), type).toBe(false);
  });

  it('stops the display from posting into the feed it renders', () => {
    expect(maySend('display', 'comment')).toBe(false);
  });

  it('stops the DJ from posting into the feed it moderates', () => {
    // Otherwise the moderator can route around its own moderation.
    expect(maySend('dj', 'comment')).toBe(false);
    expect(maySend('dj', 'transport.skip')).toBe(true);
  });

  it('sends the feed to the dashboard and the projector only', () => {
    expect(mayReadFeed('dj')).toBe(true);
    expect(mayReadFeed('display')).toBe(true);
    expect(mayReadFeed('guest')).toBe(false);
  });
});

describe('RuntimeConfigPatch', () => {
  it('validates the shipped defaults', () => {
    expect(RuntimeConfigPatch.safeParse(DEFAULT_RUNTIME_CONFIG).success).toBe(true);
  });

  it('accepts a single-key delta', () => {
    expect(RuntimeConfigPatch.safeParse({ feedHidden: true }).success).toBe(true);
  });

  it('rejects a mistyped key instead of silently dropping it', () => {
    // A setting that looks applied but isn't is worse than an error at 11pm.
    expect(RuntimeConfigPatch.safeParse({ moderationMod: 'open' }).success).toBe(false);
  });

  it('rejects out-of-range values', () => {
    expect(RuntimeConfigPatch.safeParse({ prefetchHorizonTracks: 0 }).success).toBe(false);
    expect(RuntimeConfigPatch.safeParse({ moderationMode: 'anything-goes' }).success).toBe(false);
  });
});

describe('state message', () => {
  const base = {
    t: 'state' as const,
    channelId: 'main',
    trackId: 'abc123',
    startAtServerTime: 1_724_832_000_123,
    paused: false,
    pausedAtPosition: null,
    queue: ['def456', 'ghi789'],
  };

  it('round-trips through the wire', () => {
    const parsed = ServerMessage.safeParse(JSON.parse(JSON.stringify(base)));
    expect(parsed.success).toBe(true);
  });

  it('allows an empty channel with no track', () => {
    expect(StateMsg.safeParse({ ...base, trackId: null, queue: [] }).success).toBe(true);
  });

  it('carries the paused position when paused', () => {
    expect(StateMsg.safeParse({ ...base, paused: true, pausedAtPosition: 42_000 }).success).toBe(
      true,
    );
  });
});
