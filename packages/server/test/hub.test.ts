import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@disco/shared';
import type { SegmentRecord } from '@disco/ingest';
import type { TrackRow } from '@disco/ingest/db';
import type { Session } from '../src/auth.js';
import { Comments } from '../src/comments.js';
import { Hub, type Connection, type Sink } from '../src/hub.js';
import { silentLogger } from '../src/log.js';
import { WordFilter } from '../src/profanity.js';

const T0 = 1_000_000;

const trackRecord = (id: string, durationMs: number): TrackRow => ({
  id,
  contentHash: `${id}hash`,
  sourcePath: `/music/${id}.flac`,
  title: `Track ${id}`,
  artist: 'Disco Test',
  album: null,
  durationMs,
  sampleRate: 44_100,
  channels: 2,
  integratedLufs: -16,
  truePeakDb: -2,
  gainDb: 1.85,
  bpm: 128,
  beatGridOffsetMs: 1_880.884,
  beatCount: 129,
  initPath: `tracks/${id}/init.mp4`,
  peaksPath: `tracks/${id}/peaks.json`,
  beatsPath: `tracks/${id}/beats.json`,
  artPathSmall: null,
  artPathLarge: null,
  ingestedAt: T0,
  ingestVersion: 1,
  gainTrimDb: 0,
});

const TRACKS = new Map<string, TrackRow>([
  ['aaa', trackRecord('aaa', 180_000)],
  ['bbb', trackRecord('bbb', 200_000)],
  ['ccc', trackRecord('ccc', 30_000)],
]);

const SEGMENTS: SegmentRecord[] = [
  { index: 0, path: 'tracks/aaa/seg-00000.m4s', startMs: 0, durationMs: 25_007.891, bytes: 567_431 },
];

/** Captures everything the hub sends, so a test can assert on the wire. */
class Recorder implements Sink {
  readonly sent: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  /** Messages of a type, oldest first. */
  ofType<T extends ServerMessage['t']>(t: T): Array<Extract<ServerMessage, { t: T }>> {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.ofType(t).at(-1);
  }
  clear(): void {
    this.sent.length = 0;
  }
}

type TestRole = 'guest' | 'dj' | 'display';

const session = (role: TestRole, clientId: string = role): Session => ({
  clientId,
  role,
  channels: ['*'],
  expiresAt: T0 + 1_000_000,
});

let now = T0;
let hub: Hub;
let comments: Comments;

function connect(role: TestRole, clientId?: string): [Connection, Recorder] {
  const sink = new Recorder();
  const connection = hub.connect(session(role, clientId), sink);
  return [connection, sink];
}

const send = (connection: Connection, message: unknown) =>
  hub.handleRaw(connection, JSON.stringify(message));

beforeEach(() => {
  now = T0;
  comments = new Comments({ filter: new WordFilter(['badword']) });
  hub = new Hub({
    library: {
      getTrack: (id) => TRACKS.get(id),
      getSegments: (id) => (TRACKS.has(id) ? SEGMENTS : []),
    },
    logger: silentLogger,
    comments,
    now: () => now,
    config: { minLeadTimeMs: 0 },
  });
});

describe('connection', () => {
  it('greets a client with its role, the server clock and the config', () => {
    const [, sink] = connect('guest', 'abc');
    const hello = sink.last('hello');
    expect(hello).toMatchObject({ clientId: 'abc', role: 'guest', serverTime: T0 });
    expect(hello?.config.moderationMode).toBe('review');
  });

  it('tracks connections across connect and disconnect', () => {
    const [a] = connect('guest', 'a');
    connect('guest', 'b');
    expect(hub.connections.size).toBe(2);
    hub.disconnect(a);
    expect(hub.connections.size).toBe(1);
  });
});

describe('clock sync', () => {
  it('echoes t0 and stamps t1 with server time', () => {
    const [conn, sink] = connect('guest');
    now = T0 + 42;
    send(conn, { t: 'ping', t0: 123.5 });
    expect(sink.last('pong')).toEqual({ t: 'pong', t0: 123.5, t1: T0 + 42 });
  });

  it('lets a fresh connection burst its initial sixteen samples', () => {
    // The lock-on round is sixteen pings back to back (D9). Throttling that
    // would delay every arrival at the door.
    const [conn, sink] = connect('guest');
    for (let i = 0; i < 16; i++) send(conn, { t: 'ping', t0: i });
    expect(sink.ofType('pong')).toHaveLength(16);
    expect(sink.ofType('error')).toHaveLength(0);
  });

  it('refuses a sustained flood, and says so rather than going quiet', () => {
    const [conn, sink] = connect('guest');
    for (let i = 0; i < 400; i++) send(conn, { t: 'ping', t0: i });
    const errors = sink.ofType('error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.code).toBe('rate-limited');
  });
});

describe('authorisation', () => {
  it('refuses every mutating message from a guest', () => {
    // The attack this exists for: dev tools open, message typed by hand. UI
    // that hides the button is not a control (D12, OWASP A01).
    const [dj] = connect('dj');
    send(dj, { t: 'queue.set', channelId: 'main', trackIds: ['aaa', 'bbb'] });

    const [guest, sink] = connect('guest');
    for (const message of [
      { t: 'transport.skip', channelId: 'main' },
      { t: 'transport.play', channelId: 'main' },
      { t: 'transport.pause', channelId: 'main' },
      { t: 'transport.seek', channelId: 'main', positionMs: 1000 },
      { t: 'queue.set', channelId: 'main', trackIds: [] },
      { t: 'feed.hide', hidden: true },
      { t: 'config.set', patch: { moderationMode: 'open' } },
      { t: 'comment.approve', id: 'abc' },
      { t: 'track.gain', trackId: 'aaa', gainTrimDb: -6 },
      { t: 'crate.save', name: 'Mine', trackIds: ['aaa'] },
      { t: 'crate.delete', name: 'Mine' },
      { t: 'resync' },
    ]) {
      sink.clear();
      send(guest, message);
      expect(sink.last('error')?.code).toBe('unauthorised');
    }

    // And none of it took effect.
    expect(hub.channels.get('main')?.snapshot().queue).toEqual(['aaa', 'bbb']);
    expect(comments.hidden).toBe(false);
    expect(hub.config.moderationMode).toBe('review');
  });

  it('rejects an unknown message type rather than ignoring it', () => {
    const [conn, sink] = connect('dj');
    send(conn, { t: 'transport.nuke', channelId: 'main' });
    expect(sink.last('error')?.code).toBe('bad-message');
  });

  it('rejects malformed JSON', () => {
    const [conn, sink] = connect('guest');
    hub.handleRaw(conn, '{not json');
    expect(sink.last('error')?.code).toBe('bad-message');
  });

  it('rejects a traversal attempt in a track ID before any handler sees it', () => {
    const [conn, sink] = connect('dj');
    send(conn, { t: 'queue.set', channelId: 'main', trackIds: ['../../etc/passwd'] });
    expect(sink.last('error')?.code).toBe('bad-message');
  });

  it('refuses a channel outside a scoped grant', () => {
    const sink = new Recorder();
    const scoped = hub.connect(
      { clientId: 'dj2', role: 'dj', channels: ['chill'], expiresAt: T0 + 1_000 },
      sink,
    );
    send(scoped, { t: 'transport.skip', channelId: 'main' });
    expect(sink.last('error')?.code).toBe('unauthorised');
  });
});

describe('the display is read-only', () => {
  it('refuses every mutating message from it', () => {
    // A screen in a public room that can skip tracks is a control surface
    // nobody is watching (D8).
    const [dj] = connect('dj');
    send(dj, { t: 'queue.set', channelId: 'main', trackIds: ['aaa', 'bbb'] });
    send(dj, { t: 'transport.play', channelId: 'main' });

    const [display, sink] = connect('display');
    for (const message of [
      { t: 'transport.skip', channelId: 'main' },
      { t: 'transport.pause', channelId: 'main' },
      { t: 'queue.set', channelId: 'main', trackIds: [] },
      { t: 'feed.hide', hidden: true },
      { t: 'comment.remove', id: 'abc' },
      { t: 'config.set', patch: { moderationMode: 'open' } },
    ]) {
      sink.clear();
      send(display, message);
      expect(sink.last('error')?.code).toBe('unauthorised');
    }
    expect(hub.channels.get('main')?.currentTrackId).toBe('aaa');
    expect(comments.hidden).toBe(false);
  });

  it('cannot post into the feed it renders', () => {
    const [display, sink] = connect('display');
    send(display, { t: 'comment', text: 'hello from the projector' });
    expect(sink.last('error')?.code).toBe('unauthorised');
  });

  it('receives the moderated feed', () => {
    hub.config = { ...hub.config, moderationMode: 'open' };
    const [, displaySink] = connect('display');
    const [guest] = connect('guest');
    displaySink.clear();

    send(guest, { t: 'comment', text: 'shout out to the dancefloor' });
    expect(displaySink.last('feed')?.items.map((i) => i.text)).toEqual([
      'shout out to the dancefloor',
    ]);
  });

  it('sees the panic control take effect', () => {
    const [dj] = connect('dj');
    const [, displaySink] = connect('display');
    displaySink.clear();
    send(dj, { t: 'feed.hide', hidden: true });
    expect(displaySink.last('feed')?.hidden).toBe(true);
  });

  it('sees every channel timeline without subscribing', () => {
    // It renders now-playing per channel, so it is not scoped to one (D3, D8).
    const [dj] = connect('dj');
    const [, displaySink] = connect('display');
    displaySink.clear();
    send(dj, { t: 'queue.set', channelId: 'main', trackIds: ['aaa'] });
    expect(displaySink.ofType('state')).toHaveLength(1);
  });

  it('can still sync its clock', () => {
    // The projector needs server time for beat-synced visuals, offset by one
    // global number rather than per-guest calibration (D8).
    const [display, sink] = connect('display');
    now = T0 + 7;
    send(display, { t: 'ping', t0: 99 });
    expect(sink.last('pong')).toEqual({ t: 'pong', t0: 99, t1: T0 + 7 });
  });
});

describe('subscribe and state', () => {
  it('sends state and the horizon metadata on subscribe', () => {
    const [dj] = connect('dj');
    send(dj, { t: 'queue.set', channelId: 'main', trackIds: ['aaa', 'bbb'] });
    send(dj, { t: 'transport.play', channelId: 'main' });

    const [guest, sink] = connect('guest');
    send(guest, { t: 'subscribe', channelId: 'main' });

    expect(sink.last('state')).toMatchObject({
      channelId: 'main',
      trackId: 'aaa',
      startAtServerTime: T0,
      queue: ['bbb'],
    });
    const meta = sink.ofType('trackMeta');
    expect(meta.map((m) => m.trackId)).toEqual(['aaa', 'bbb']);
    expect(meta[0]).toMatchObject({
      initUrl: '/media/tracks/aaa/init.mp4',
      beatsUrl: '/media/tracks/aaa/beats.json',
      gainDb: 1.85,
      bpm: 128,
    });
    expect(meta[0]?.segments[0]?.url).toBe('/media/tracks/aaa/seg-00000.m4s');
  });

  it('rejects a channel that is not running', () => {
    const [guest, sink] = connect('guest');
    send(guest, { t: 'subscribe', channelId: 'nonexistent' });
    expect(sink.last('error')?.code).toBe('unknown-channel');
  });

  it('broadcasts state to subscribers and to the DJ, and to nobody else', () => {
    const [dj, djSink] = connect('dj');
    const [subscribed, subSink] = connect('guest', 'sub');
    const [idle, idleSink] = connect('guest', 'idle');
    send(subscribed, { t: 'subscribe', channelId: 'main' });

    djSink.clear();
    subSink.clear();
    idleSink.clear();
    send(dj, { t: 'queue.set', channelId: 'main', trackIds: ['aaa'] });

    expect(djSink.ofType('state')).toHaveLength(1);
    expect(subSink.ofType('state')).toHaveLength(1);
    // A guest that never subscribed prefetches nothing and hears nothing (D3).
    expect(idleSink.sent).toHaveLength(0);
    expect(idle.channelId).toBeNull();
  });

  it('refuses to queue a track that is not in the manifest', () => {
    const [dj, sink] = connect('dj');
    send(dj, { t: 'queue.set', channelId: 'main', trackIds: ['aaa', 'zzz'] });
    expect(sink.last('error')?.code).toBe('unknown-track');
    expect(hub.channels.get('main')?.snapshot().queue).toEqual([]);
  });

  it('advances the timeline on tick and tells the room', () => {
    const [dj] = connect('dj');
    send(dj, { t: 'queue.set', channelId: 'main', trackIds: ['ccc', 'aaa'] });
    send(dj, { t: 'transport.play', channelId: 'main' });

    const [guest, sink] = connect('guest');
    send(guest, { t: 'subscribe', channelId: 'main' });
    sink.clear();

    now = T0 + 30_000 + 137;
    hub.tick();

    expect(sink.last('state')).toMatchObject({
      trackId: 'aaa',
      // Pinned to the previous track's exact end, not to the late tick (D6).
      startAtServerTime: T0 + 30_000,
    });
  });
});

describe('minimum lead time', () => {
  it('refuses to start a track the room has not had time to fetch', () => {
    // Starting a track nobody has is thirty simultaneous buffering stalls (D5).
    const leadHub = new Hub({
      library: { getTrack: (id) => TRACKS.get(id), getSegments: () => SEGMENTS },
      logger: silentLogger,
      comments,
      now: () => now,
      config: { minLeadTimeMs: 180_000 },
    });
    const sink = new Recorder();
    const dj = leadHub.connect(session('dj'), sink);
    const say = (message: unknown) => leadHub.handleRaw(dj, JSON.stringify(message));
    const play = { t: 'transport.play', channelId: 'main', trackId: 'aaa' };

    say({ t: 'queue.set', channelId: 'main', trackIds: ['aaa'] });

    sink.clear();
    say(play);
    expect(sink.last('error')?.message).toMatch(/ready in \d+s/);
    expect(sink.last('state')).toBeUndefined();

    now = T0 + 180_000;
    sink.clear();
    say(play);
    expect(sink.last('state')?.trackId).toBe('aaa');
  });
});

describe('gain trim', () => {
  /** A hub whose library records trims, as SQLite does in production. */
  const trimHub = () => {
    const trims = new Map<string, number>();
    const hubWithTrims = new Hub({
      library: {
        getTrack: (id) => {
          const track = TRACKS.get(id);
          return track ? { ...track, gainTrimDb: trims.get(id) ?? 0 } : undefined;
        },
        getSegments: () => SEGMENTS,
        setGainTrim: (id, db) => {
          if (!TRACKS.has(id)) return false;
          trims.set(id, db);
          return true;
        },
      },
      logger: silentLogger,
      comments,
      now: () => now,
      config: { minLeadTimeMs: 0 },
    });
    return { hub: hubWithTrims, trims };
  };

  it('sums the ingested gain and the DJ trim into the one number a client applies', () => {
    const { hub: h } = trimHub();
    const sink = new Recorder();
    const dj = h.connect(session('dj'), sink);
    h.handleRaw(dj, JSON.stringify({ t: 'queue.set', channelId: 'main', trackIds: ['aaa'] }));
    h.handleRaw(dj, JSON.stringify({ t: 'transport.play', channelId: 'main' }));

    sink.clear();
    h.handleRaw(dj, JSON.stringify({ t: 'track.gain', trackId: 'aaa', gainTrimDb: -3 }));

    const meta = sink.last('trackMeta');
    expect(meta?.trackId).toBe('aaa');
    // 1.85 dB from ingest, −3 dB from the DJ. The client never learns there
    // were two numbers.
    expect(meta?.gainDb).toBeCloseTo(-1.15, 6);
  });

  it('tells the room immediately rather than at the next track boundary', () => {
    const { hub: h } = trimHub();
    const djSink = new Recorder();
    const dj = h.connect(session('dj'), djSink);
    const guestSink = new Recorder();
    const guest = h.connect(session('guest', 'phone'), guestSink);
    h.handleRaw(guest, JSON.stringify({ t: 'subscribe', channelId: 'main' }));
    guestSink.clear();

    h.handleRaw(dj, JSON.stringify({ t: 'track.gain', trackId: 'bbb', gainTrimDb: 2 }));
    expect(guestSink.last('trackMeta')?.trackId).toBe('bbb');
  });

  it('refuses a trim for a track that is not in the library', () => {
    const { hub: h } = trimHub();
    const sink = new Recorder();
    const dj = h.connect(session('dj'), sink);
    h.handleRaw(dj, JSON.stringify({ t: 'track.gain', trackId: 'zzz', gainTrimDb: 1 }));
    expect(sink.last('error')?.code).toBe('unknown-track');
  });

  it('refuses a trim wide enough to be a hazard', () => {
    const { hub: h, trims } = trimHub();
    const sink = new Recorder();
    const dj = h.connect(session('dj'), sink);
    h.handleRaw(dj, JSON.stringify({ t: 'track.gain', trackId: 'aaa', gainTrimDb: 40 }));
    expect(sink.last('error')?.code).toBe('bad-message');
    expect(trims.has('aaa')).toBe(false);
  });
});

describe('crates', () => {
  it('saves, lists and deletes, and only the dashboard sees them', () => {
    const saved: string[][] = [];
    const crateHub = new Hub({
      library: { getTrack: (id) => TRACKS.get(id), getSegments: () => SEGMENTS },
      logger: silentLogger,
      comments,
      now: () => now,
      onCratesChange: (crates) => saved.push(crates.map((c) => c.name)),
    });

    const djSink = new Recorder();
    const dj = crateHub.connect(session('dj'), djSink);
    const displaySink = new Recorder();
    crateHub.connect(session('display', 'projector'), displaySink);
    displaySink.clear();

    crateHub.handleRaw(dj, JSON.stringify({ t: 'crate.save', name: 'Warm up', trackIds: ['aaa'] }));
    expect(djSink.last('crates')?.items).toEqual([{ name: 'Warm up', trackIds: ['aaa'] }]);
    // The projector has no use for the catalogue.
    expect(displaySink.last('crates')).toBeUndefined();
    expect(saved.at(-1)).toEqual(['Warm up']);

    // Saving the same name replaces rather than duplicates.
    crateHub.handleRaw(
      dj,
      JSON.stringify({ t: 'crate.save', name: 'Warm up', trackIds: ['aaa', 'bbb'] }),
    );
    expect(djSink.last('crates')?.items).toEqual([{ name: 'Warm up', trackIds: ['aaa', 'bbb'] }]);

    crateHub.handleRaw(dj, JSON.stringify({ t: 'crate.delete', name: 'Warm up' }));
    expect(djSink.last('crates')?.items).toEqual([]);
  });

  it('refuses a crate holding a track the library does not have', () => {
    const [dj, sink] = connect('dj');
    send(dj, { t: 'crate.save', name: 'Ghosts', trackIds: ['aaa', 'zzz'] });
    expect(sink.last('error')?.code).toBe('unknown-track');
    expect(hub.crates).toEqual([]);
  });

  it('refuses a name that is not a name', () => {
    const [dj, sink] = connect('dj');
    send(dj, { t: 'crate.save', name: '../../etc/passwd', trackIds: [] });
    expect(sink.last('error')?.code).toBe('bad-message');
  });

  it('hands a reconnecting DJ its crates back without being asked', () => {
    // A laptop wakes, a tab is restored. Re-deriving the crates by hand at that
    // moment is the last thing the DJ has attention for.
    const restored = new Hub({
      library: { getTrack: (id) => TRACKS.get(id), getSegments: () => SEGMENTS },
      logger: silentLogger,
      comments,
      now: () => now,
      crates: [{ name: 'Peak', trackIds: ['bbb'] }],
    });
    const sink = new Recorder();
    restored.connect(session('dj'), sink);
    expect(sink.last('crates')?.items).toEqual([{ name: 'Peak', trackIds: ['bbb'] }]);
  });
});

describe('the venue profile', () => {
  it('reports config changes worth keeping', () => {
    const patches: unknown[] = [];
    const persisting = new Hub({
      library: { getTrack: (id) => TRACKS.get(id), getSegments: () => SEGMENTS },
      logger: silentLogger,
      comments,
      now: () => now,
      onConfigChange: (patch) => patches.push(patch),
    });
    const dj = persisting.connect(session('dj'), new Recorder());
    persisting.handleRaw(dj, JSON.stringify({ t: 'config.set', patch: { projectorOffsetMs: 55 } }));
    expect(patches).toEqual([{ projectorOffsetMs: 55 }]);
  });

  it('starts from the profile it was given', () => {
    const started = new Hub({
      library: { getTrack: (id) => TRACKS.get(id), getSegments: () => SEGMENTS },
      logger: silentLogger,
      comments,
      now: () => now,
      config: { projectorOffsetMs: 65 },
    });
    const sink = new Recorder();
    started.connect(session('display', 'projector'), sink);
    expect(sink.last('hello')?.config.projectorOffsetMs).toBe(65);
  });
});

describe('comments', () => {
  it('publishes straight to the feed in open mode', () => {
    hub.config = { ...hub.config, moderationMode: 'open' };
    const [, djSink] = connect('dj');
    const [guest, guestSink] = connect('guest');
    djSink.clear();

    send(guest, { t: 'comment', text: 'play something faster' });

    expect(djSink.last('feed')?.items.map((i) => i.text)).toEqual(['play something faster']);
    // Guests submit to the feed; they do not read it (D7).
    expect(guestSink.ofType('feed')).toHaveLength(0);
  });

  it('holds for the DJ in review mode and publishes on approval', () => {
    const [dj, djSink] = connect('dj');
    const [guest] = connect('guest');

    send(guest, { t: 'comment', text: 'more cowbell' });
    const held = djSink.last('feed');
    expect(held?.items).toEqual([]);
    expect(held?.pending.map((i) => i.text)).toEqual(['more cowbell']);

    send(dj, { t: 'comment.approve', id: held?.pending[0]?.id ?? '' });
    expect(djSink.last('feed')?.items.map((i) => i.text)).toEqual(['more cowbell']);
    expect(djSink.last('feed')?.pending).toEqual([]);
  });

  it('rejects filtered text without saying why', () => {
    // Telling a submitter which word tripped the filter is a tuning interface
    // for getting past it.
    const [guest, sink] = connect('guest');
    send(guest, { t: 'comment', text: 'badword' });
    const error = sink.last('error');
    expect(error?.code).toBe('comment-rejected');
    expect(error?.message).not.toMatch(/badword/);
    expect(comments.pendingCount).toBe(0);
  });

  it('rate-limits submissions hard', () => {
    const [guest, sink] = connect('guest');
    for (let i = 0; i < 10; i++) send(guest, { t: 'comment', text: `message ${i}` });
    expect(sink.ofType('error').some((e) => e.code === 'rate-limited')).toBe(true);
    expect(comments.pendingCount).toBeLessThanOrEqual(3);
  });

  it('hides the feed on the panic control and tells everyone', () => {
    const [dj, djSink] = connect('dj');
    const [guest, guestSink] = connect('guest');
    djSink.clear();
    guestSink.clear();

    send(dj, { t: 'feed.hide', hidden: true });

    expect(djSink.last('feed')?.hidden).toBe(true);
    // The config delta reaches every client, so a relocated display picks it up.
    expect(guestSink.last('config')?.patch).toEqual({ feedHidden: true });
    expect(hub.config.feedHidden).toBe(true);
  });

  it('expires stale pending comments on tick', () => {
    const [, djSink] = connect('dj');
    const [guest] = connect('guest');
    send(guest, { t: 'comment', text: 'from three tracks ago' });
    expect(comments.pendingCount).toBe(1);

    djSink.clear();
    now = T0 + hub.config.commentPendingExpiryMs + 1;
    hub.tick();

    expect(comments.pendingCount).toBe(0);
    expect(djSink.last('feed')?.pending).toEqual([]);
  });
});

describe('remote config', () => {
  it('applies a valid patch and broadcasts it', () => {
    const [dj] = connect('dj');
    const [, guestSink] = connect('guest');
    send(dj, { t: 'config.set', patch: { prefetchHorizonTracks: 3, moderationMode: 'open' } });

    expect(hub.config.prefetchHorizonTracks).toBe(3);
    expect(hub.config.moderationMode).toBe('open');
    expect(guestSink.last('config')?.patch).toEqual({
      prefetchHorizonTracks: 3,
      moderationMode: 'open',
    });
  });

  it('rejects an unknown setting rather than silently dropping it', () => {
    const [dj, sink] = connect('dj');
    send(dj, { t: 'config.set', patch: { moderationMod: 'open' } });
    expect(sink.last('error')?.code).toBe('bad-message');
  });

  it('leaves other settings alone', () => {
    const [dj] = connect('dj');
    const before = hub.config.commentsPerMinute;
    send(dj, { t: 'config.set', patch: { projectorOffsetMs: 40 } });
    expect(hub.config.projectorOffsetMs).toBe(40);
    expect(hub.config.commentsPerMinute).toBe(before);
  });
});

describe('telemetry', () => {
  it('records the latest reading per connection for the dashboard', () => {
    const [guest] = connect('guest', 'phone-1');
    send(guest, { t: 'subscribe', channelId: 'main' });
    send(guest, {
      t: 'telemetry',
      offsetMs: -1234.5,
      rttMs: 8,
      driftMs: 3,
      calibrationMs: 180,
      engine: 'webaudio',
      bufferSec: 42,
      playing: true,
      ready: [{ trackId: 'aaa', state: 'ready' }],
    });

    expect(hub.telemetrySnapshot()).toContainEqual(
      expect.objectContaining({
        clientId: 'phone-1',
        channelId: 'main',
        rttMs: 8,
        calibrationMs: 180,
        engine: 'webaudio',
        playing: true,
      }),
    );
  });
});

describe('readiness', () => {
  /** A guest on `main` reporting one readiness state per track. */
  const guestReporting = (clientId: string, ready: Array<[string, string]>, playing = true) => {
    const [guest] = connect('guest', clientId);
    send(guest, { t: 'subscribe', channelId: 'main' });
    send(guest, {
      t: 'telemetry',
      offsetMs: 0,
      rttMs: 4,
      driftMs: 0,
      calibrationMs: 0,
      engine: 'webaudio',
      bufferSec: 30,
      playing,
      ready: ready.map(([trackId, state]) => ({ trackId, state })),
    });
    return guest;
  };

  it('counts the room per track across the horizon', () => {
    const [dj] = connect('dj');
    send(dj, { t: 'queue.set', channelId: 'main', trackIds: ['aaa', 'bbb'] });
    send(dj, { t: 'transport.play', channelId: 'main' });

    guestReporting('p1', [
      ['aaa', 'ready'],
      ['bbb', 'partial'],
    ]);
    guestReporting('p2', [
      ['aaa', 'ready'],
      ['bbb', 'not-ready'],
    ]);

    const readiness = hub.readinessSnapshot('main');
    expect(readiness).toEqual([
      { trackId: 'aaa', ready: 2, partial: 0, notReady: 0, listeners: 2, publishedAtServerTime: T0 },
      { trackId: 'bbb', ready: 0, partial: 1, notReady: 1, listeners: 2, publishedAtServerTime: T0 },
    ]);
  });

  it('counts a guest that has not reported yet as not ready', () => {
    // Nothing is known about that phone's buffer, and "unknown" on a readiness
    // bar has to read as "do not start yet" (D5).
    const [dj] = connect('dj');
    send(dj, { t: 'queue.set', channelId: 'main', trackIds: ['aaa'] });
    send(dj, { t: 'transport.play', channelId: 'main' });
    // Connected but not subscribed to this channel: it is not one of this
    // channel's listeners and must not be counted against it (D3).
    connect('guest', 'silent');
    expect(hub.readinessSnapshot('main')).toEqual([
      { trackId: 'aaa', ready: 0, partial: 0, notReady: 0, listeners: 0, publishedAtServerTime: T0 },
    ]);

    const [silent] = connect('guest', 'subscribed');
    send(silent, { t: 'subscribe', channelId: 'main' });
    expect(hub.readinessSnapshot('main')).toEqual([
      { trackId: 'aaa', ready: 0, partial: 0, notReady: 1, listeners: 1, publishedAtServerTime: T0 },
    ]);
  });

  it('does not count the dashboard or the projector as listeners', () => {
    // Neither downloads audio, and counting them would make "28/30" wrong in
    // the direction that reads as safe.
    const [dj] = connect('dj');
    connect('display', 'projector');
    send(dj, { t: 'queue.set', channelId: 'main', trackIds: ['aaa'] });
    send(dj, { t: 'transport.play', channelId: 'main' });
    guestReporting('p1', [['aaa', 'ready']]);

    expect(hub.readinessSnapshot('main')[0]).toEqual({
      trackId: 'aaa',
      ready: 1,
      partial: 0,
      notReady: 0,
      listeners: 1,
      // The lead-time badge reads this: a track two minutes from startable
      // should say so rather than being discovered by pressing play (D5).
      publishedAtServerTime: T0,
    });
  });

  it('reports who is listening for download admission', () => {
    guestReporting('playing-phone', [['aaa', 'ready']], true);
    guestReporting('joining-phone', [['aaa', 'not-ready']], false);

    expect(hub.isListening('playing-phone')).toBe(true);
    expect(hub.isListening('joining-phone')).toBe(false);
    // An unknown client is a joiner: the cost of that mistake is a queued
    // segment, and the cost of the reverse is someone at the door (D4).
    expect(hub.isListening('never-seen')).toBe(false);
  });
});
