/**
 * The live server: connections, dispatch, and the broadcast of state.
 *
 * Deliberately transport-agnostic. A connection is anything with `send` and
 * `close`, which is what lets the virtual-client harness exercise thirty
 * clients' worth of behaviour without a socket in sight (Part E step 6).
 */

import {
  DEFAULT_CHANNEL_ID,
  DEFAULT_RUNTIME_CONFIG,
  PROTOCOL_VERSION,
  RuntimeConfigPatch,
  mayReadCrates,
  mayReadFeed,
  mergeConfig,
  parseClientMessage,
  type ClientMessage,
  type Crate,
  type ErrorCode,
  type FeedItem,
  type ReadinessState,
  type RuntimeConfig,
  type SegmentMeta,
  type ServerMessage,
  type TrackMetaMsg,
  type TrackReadiness,
} from '@disco/shared';
import type { Library } from '@disco/ingest/db';
import { mayActOnChannel, requireRole, type Session } from './auth.js';
import { Channel } from './channel.js';
import { Comments } from './comments.js';
import type { Logger } from './log.js';
import { ConnectionLimits } from './ratelimit.js';

/** Anything that can carry frames to a client. */
export interface Sink {
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface Telemetry {
  offsetMs: number;
  rttMs: number;
  driftMs: number;
  calibrationMs: number;
  engine: string;
  bufferSec: number;
  /** Hearing audio right now, as opposed to merely connected (D4, D11). */
  playing: boolean;
  /** Readiness across the horizon, aggregated into the dashboard's bars (D5). */
  ready: TrackReadiness[];
  at: number;
}

/** One row of the dashboard's readiness bar: "28/30 ready" (D5). */
export interface TrackReadinessSummary {
  trackId: string;
  ready: number;
  partial: number;
  notReady: number;
  /** Guests subscribed to the channel, whether or not they have reported yet. */
  listeners: number;
  /** When the room first saw this track, for the lead-time badge (D5). */
  publishedAtServerTime: number | null;
}

export interface Connection {
  readonly session: Session;
  readonly sink: Sink;
  readonly limits: ConnectionLimits;
  readonly connectedAt: number;
  channelId: string | null;
  telemetry: Telemetry | null;
}

export interface HubDeps {
  library: Pick<Library, 'getTrack' | 'getSegments'> &
    Partial<Pick<Library, 'listTracks' | 'countMatching' | 'setGainTrim'>>;
  logger: Logger;
  now: () => number;
  channelIds?: string[];
  comments: Comments;
  /**
   * Starting config, usually the venue profile. Written as an explicitly
   * optional-valued map rather than `Partial<…>` because a Zod partial produces
   * the former, and under `exactOptionalPropertyTypes` those are different
   * types.
   */
  config?: { [K in keyof RuntimeConfig]?: RuntimeConfig[K] | undefined };
  /** Crates restored from the venue profile at boot (D10). */
  crates?: Crate[];
  /**
   * Called when the DJ changes something worth keeping. The hub does not know
   * about files; the venue store does, and it decides what is worth persisting.
   */
  onConfigChange?: (patch: RuntimeConfigPatch) => void;
  onCratesChange?: (crates: readonly Crate[]) => void;
}

export class Hub {
  readonly channels = new Map<string, Channel>();
  readonly connections = new Set<Connection>();
  config: RuntimeConfig;
  #crates: Crate[];

  constructor(private readonly deps: HubDeps) {
    this.config = mergeConfig(DEFAULT_RUNTIME_CONFIG, deps.config);
    this.#crates = (deps.crates ?? []).map((c) => ({ ...c, trackIds: [...c.trackIds] }));
    for (const id of deps.channelIds ?? [DEFAULT_CHANNEL_ID]) {
      this.channels.set(
        id,
        new Channel(id, { durationOf: (trackId) => this.#durationOf(trackId) }),
      );
    }
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  connect(session: Session, sink: Sink): Connection {
    const now = this.deps.now();
    const connection: Connection = {
      session,
      sink,
      limits: new ConnectionLimits(this.config.pingsPerMinute, this.config.commentsPerMinute, now),
      connectedAt: now,
      channelId: null,
      telemetry: null,
    };
    this.connections.add(connection);

    // Connection events are logged; payloads never are (D12).
    this.deps.logger.event('info', 'ws.connect', {
      clientId: session.clientId,
      role: session.role,
      connections: this.connections.size,
    });

    this.#send(connection, {
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      clientId: session.clientId,
      role: session.role,
      serverTime: now,
      channels: session.channels,
      config: this.config,
    });

    // The dashboard's crates and the feed are connection state, not a poll: a
    // DJ reloading mid-set gets both back without asking (D7, D10).
    if (mayReadCrates(session.role)) this.#send(connection, { t: 'crates', items: this.crates });
    if (mayReadFeed(session.role)) {
      this.#send(connection, {
        t: 'feed',
        items: this.deps.comments.published(),
        pending: this.deps.comments.pending(),
        hidden: this.deps.comments.hidden,
      });
    }
    return connection;
  }

  disconnect(connection: Connection): void {
    this.connections.delete(connection);
    this.deps.logger.event('info', 'ws.disconnect', {
      clientId: connection.session.clientId,
      role: connection.session.role,
      seconds: Math.round((this.deps.now() - connection.connectedAt) / 1000),
      connections: this.connections.size,
    });
  }

  // ── Inbound ───────────────────────────────────────────────────────────────

  /** Parse, authorise, dispatch. The only entry point for client data. */
  handleRaw(connection: Connection, raw: string): void {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      // Rejected, not ignored: an ignored message is an uncounted one. The
      // detail stays in the log and does not go back over the wire.
      this.deps.logger.event('warn', 'ws.bad-message', {
        clientId: connection.session.clientId,
        detail: parsed.detail,
      });
      this.#error(connection, 'bad-message', 'Unrecognised message.');
      return;
    }

    const message = parsed.value;

    // The single authorisation guard. Every mutating handler is behind it, and
    // none of them re-checks — one place to read, one place to get right.
    if (!requireRole(connection.session.role, message.t)) {
      this.deps.logger.event('warn', 'ws.unauthorised', {
        clientId: connection.session.clientId,
        role: connection.session.role,
        type: message.t,
      });
      this.#error(connection, 'unauthorised', 'Not allowed.');
      return;
    }

    const channelId = 'channelId' in message ? message.channelId : undefined;
    if (channelId !== undefined && !mayActOnChannel(connection.session, channelId)) {
      this.#error(connection, 'unauthorised', 'Not allowed.');
      return;
    }

    this.#dispatch(connection, message);
  }

  #dispatch(connection: Connection, message: ClientMessage): void {
    const now = this.deps.now();

    switch (message.t) {
      case 'ping': {
        if (!connection.limits.ping.take(now)) {
          // Silent on the wire would leave a client waiting on a pong that is
          // never coming, so the refusal is explicit.
          this.#error(connection, 'rate-limited', 'Too many clock syncs.');
          return;
        }
        this.#send(connection, { t: 'pong', t0: message.t0, t1: now });
        return;
      }

      case 'subscribe': {
        const channel = this.channels.get(message.channelId);
        if (!channel) {
          this.#error(connection, 'unknown-channel', 'That channel is not running.');
          return;
        }
        connection.channelId = message.channelId;
        this.#send(connection, channel.toStateMessage());
        for (const meta of this.#horizonMeta(channel)) this.#send(connection, meta);
        return;
      }

      case 'telemetry': {
        connection.telemetry = { ...message, at: now };
        return;
      }

      case 'comment': {
        if (!connection.limits.comment.take(now)) {
          this.#error(
            connection,
            'rate-limited',
            this.config.strings['commentRateLimited'] ?? 'Slow down.',
          );
          return;
        }
        const result = this.deps.comments.submit(message.text, now, this.config.moderationMode);
        if (result.status === 'rejected') {
          // The reason is not returned: telling a submitter exactly which word
          // tripped the filter is a tuning interface for getting past it.
          this.deps.logger.event('info', 'comment.rejected', {
            clientId: connection.session.clientId,
            reason: result.reason,
          });
          this.#error(
            connection,
            'comment-rejected',
            this.config.strings['commentRejected'] ?? 'Not sent.',
          );
          return;
        }
        this.deps.logger.event('info', 'comment.accepted', {
          clientId: connection.session.clientId,
          status: result.status,
        });
        this.broadcastFeed();
        return;
      }

      case 'queue.set': {
        const channel = this.#channelOrError(connection, message.channelId);
        if (!channel) return;
        const known = message.trackIds.filter((id) => this.deps.library.getTrack(id) !== undefined);
        if (known.length !== message.trackIds.length) {
          this.#error(connection, 'unknown-track', 'One or more tracks are not in the library.');
          return;
        }
        channel.setQueue(known, now);
        this.#broadcastState(channel);
        return;
      }

      case 'transport.play': {
        const channel = this.#channelOrError(connection, message.channelId);
        if (!channel) return;
        if (message.trackId) {
          if (this.deps.library.getTrack(message.trackId) === undefined) {
            this.#error(connection, 'unknown-track', 'That track is not in the library.');
            return;
          }
          // Lead time is a real constraint, not advice: a track the room has
          // not had time to fetch starts as thirty simultaneous buffering
          // stalls (D5).
          const readyAt = channel.readyAt(message.trackId, this.config.minLeadTimeMs);
          const startAt = message.atServerTime ?? now;
          if (startAt < readyAt) {
            this.#error(
              connection,
              'bad-message',
              `Published too recently — ready in ${Math.ceil((readyAt - startAt) / 1000)}s.`,
            );
            return;
          }
        }
        channel.play(now, message.trackId, message.fromPositionMs ?? 0, message.atServerTime);
        this.#broadcastState(channel);
        return;
      }

      case 'transport.pause': {
        const channel = this.#channelOrError(connection, message.channelId);
        if (channel?.pause(now)) this.#broadcastState(channel);
        return;
      }

      case 'transport.skip': {
        const channel = this.#channelOrError(connection, message.channelId);
        if (channel?.skip(now)) this.#broadcastState(channel);
        return;
      }

      case 'transport.seek': {
        const channel = this.#channelOrError(connection, message.channelId);
        if (channel?.seek(message.positionMs, now)) this.#broadcastState(channel);
        return;
      }

      case 'track.gain': {
        // Stored in the manifest rather than the venue profile: the correction
        // belongs to the track wherever it is played (D11).
        const applied = this.deps.library.setGainTrim?.(message.trackId, message.gainTrimDb);
        if (!applied) {
          this.#error(connection, 'unknown-track', 'That track is not in the library.');
          return;
        }
        this.deps.logger.event('info', 'track.gain', {
          clientId: connection.session.clientId,
          trackId: message.trackId,
          gainTrimDb: message.gainTrimDb,
        });
        // Re-send the metadata so the room applies the new gain on the next
        // segment rather than at the next track boundary.
        this.#broadcastTrackMeta(message.trackId);
        return;
      }

      case 'crate.save': {
        const unknown = message.trackIds.filter(
          (id) => this.deps.library.getTrack(id) === undefined,
        );
        if (unknown.length > 0) {
          this.#error(connection, 'unknown-track', 'One or more tracks are not in the library.');
          return;
        }
        const others = this.#crates.filter((c) => c.name !== message.name);
        // Newest first: a crate saved during the set is the one being worked on.
        this.#crates = [{ name: message.name, trackIds: [...message.trackIds] }, ...others];
        this.deps.onCratesChange?.(this.#crates);
        this.broadcastCrates();
        return;
      }

      case 'crate.delete': {
        const before = this.#crates.length;
        this.#crates = this.#crates.filter((c) => c.name !== message.name);
        if (this.#crates.length === before) return;
        this.deps.onCratesChange?.(this.#crates);
        this.broadcastCrates();
        return;
      }

      case 'comment.approve': {
        if (this.deps.comments.approve(message.id)) this.broadcastFeed();
        return;
      }

      case 'comment.reject': {
        if (this.deps.comments.reject(message.id)) this.broadcastFeed();
        return;
      }

      case 'comment.remove': {
        if (this.deps.comments.remove(message.id)) this.broadcastFeed();
        return;
      }

      case 'feed.hide': {
        this.deps.comments.setHidden(message.hidden);
        this.config = { ...this.config, feedHidden: message.hidden };
        this.deps.logger.event('warn', 'feed.hide', {
          clientId: connection.session.clientId,
          hidden: message.hidden,
        });
        this.broadcastFeed();
        this.broadcastConfig({ feedHidden: message.hidden });
        return;
      }

      case 'config.set': {
        const patch = RuntimeConfigPatch.safeParse(message.patch);
        if (!patch.success) {
          this.#error(connection, 'bad-message', 'Unrecognised setting.');
          return;
        }
        this.config = mergeConfig(this.config, patch.data);
        this.deps.logger.event('info', 'config.set', {
          clientId: connection.session.clientId,
          keys: Object.keys(patch.data).join(','),
        });
        // The venue store keeps what belongs to the venue — the projector
        // offset above all, which nobody should have to measure twice (D8).
        this.deps.onConfigChange?.(patch.data);
        this.broadcastConfig(patch.data);
        return;
      }

      case 'resync': {
        // Re-send state to everyone on the channel. The client's own position
        // math does the rest — there is no separate "catch up" path.
        const targets = message.channelId
          ? [this.channels.get(message.channelId)].filter((c): c is Channel => c !== undefined)
          : [...this.channels.values()];
        for (const channel of targets) this.#broadcastState(channel);
        return;
      }
    }
  }

  // ── Periodic work ─────────────────────────────────────────────────────────

  /**
   * Advance timelines and expire stale pending comments. Called on a timer by
   * the server; separated out so tests can drive time directly.
   */
  tick(): void {
    const now = this.deps.now();
    for (const channel of this.channels.values()) {
      if (channel.tick(now)) this.#broadcastState(channel);
    }
    if (this.deps.comments.expirePending(now, this.config.commentPendingExpiryMs) > 0) {
      this.broadcastFeed();
    }
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  broadcastFeed(): void {
    const message: ServerMessage = {
      t: 'feed',
      items: this.deps.comments.published(),
      pending: this.deps.comments.pending(),
      hidden: this.deps.comments.hidden,
    };
    // Guests submit to the feed; they do not read it. Only the dashboard and
    // the projector receive it (D7).
    for (const connection of this.connections) {
      if (mayReadFeed(connection.session.role)) this.#send(connection, message);
    }
  }

  broadcastConfig(patch: RuntimeConfigPatch): void {
    for (const connection of this.connections) {
      this.#send(connection, { t: 'config', patch });
    }
  }

  get crates(): Crate[] {
    return this.#crates.map((c) => ({ ...c, trackIds: [...c.trackIds] }));
  }

  broadcastCrates(): void {
    const message: ServerMessage = { t: 'crates', items: this.crates };
    for (const connection of this.connections) {
      if (mayReadCrates(connection.session.role)) this.#send(connection, message);
    }
  }

  /**
   * The library as the dashboard shows it: manifest rows plus the readiness the
   * timeline knows about. Trimmed to what the list actually renders — the
   * dashboard has no use for a source path or a content hash.
   */
  listLibrary(options: {
    q?: string;
    limit?: number;
    offset?: number;
    sort?: 'artist' | 'title' | 'bpm' | 'recent';
  }): {
    tracks: Array<{
      trackId: string;
      title: string;
      artist: string;
      album: string | null;
      durationMs: number;
      bpm: number | null;
      gainDb: number;
      gainTrimDb: number;
    }>;
    /** Total matches, so the list can page and virtualise over thousands (D10). */
    total: number;
  } {
    const rows = this.deps.library.listTracks?.(options) ?? [];
    return {
      tracks: rows.map((t) => ({
        trackId: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        durationMs: t.durationMs,
        bpm: t.bpm,
        gainDb: t.gainDb,
        gainTrimDb: t.gainTrimDb ?? 0,
      })),
      total: this.deps.library.countMatching?.(options.q) ?? rows.length,
    };
  }

  /** Every connection's latest telemetry, for the dashboard panel (D11). */
  telemetrySnapshot(): Array<
    { clientId: string; role: string; channelId: string | null } & Partial<Telemetry>
  > {
    return [...this.connections].map((c) => ({
      clientId: c.session.clientId,
      role: c.session.role,
      channelId: c.channelId,
      ...(c.telemetry ?? {}),
    }));
  }

  /**
   * Whether a client is hearing audio, for download admission (D4).
   *
   * Unknown clients count as joiners. That is the safe default: the cost of
   * treating a listener as a joiner is a queued segment, and the cost of the
   * reverse is someone at the door never finishing their buffer.
   */
  isListening(clientId: string): boolean {
    for (const connection of this.connections) {
      if (connection.session.clientId === clientId) return connection.telemetry?.playing === true;
    }
    return false;
  }

  /**
   * Readiness across a channel's horizon — the "28/30 ready" widget (D5).
   *
   * This single readout prevents most live failure modes, because it lets the
   * DJ hold a track when the room is not there yet. Counted over guests
   * subscribed to the channel; the dashboard and the projector are connections
   * too and neither downloads audio.
   */
  readinessSnapshot(channelId: string): TrackReadinessSummary[] {
    const channel = this.channels.get(channelId);
    if (!channel) return [];

    const guests = [...this.connections].filter(
      (c) => c.session.role === 'guest' && c.channelId === channelId,
    );

    return channel.horizon(this.config.prefetchHorizonTracks).map((trackId) => {
      const summary: TrackReadinessSummary = {
        trackId,
        ready: 0,
        partial: 0,
        notReady: 0,
        listeners: guests.length,
        publishedAtServerTime: channel.publishedAt(trackId),
      };
      for (const guest of guests) {
        // A guest that has not reported on this track yet counts as not ready,
        // which is what it is: nothing is known about its buffer.
        const state: ReadinessState =
          guest.telemetry?.ready.find((r) => r.trackId === trackId)?.state ?? 'not-ready';
        if (state === 'ready') summary.ready++;
        else if (state === 'partial') summary.partial++;
        else summary.notReady++;
      }
      return summary;
    });
  }

  /** When a track's gain trim changes, everyone holding it needs to know. */
  #broadcastTrackMeta(trackId: string): void {
    const meta = this.trackMeta(trackId);
    if (!meta) return;
    for (const connection of this.connections) this.#send(connection, meta);
  }

  #broadcastState(channel: Channel): void {
    const state = channel.toStateMessage();
    const meta = this.#horizonMeta(channel);
    for (const connection of this.connections) {
      // The dashboard and the projector both render now-playing per channel, so
      // they see every timeline. A guest sees only the one it subscribed to,
      // and prefetches only that channel's horizon (D3).
      const interested =
        connection.session.role !== 'guest' || connection.channelId === channel.id;
      if (!interested) continue;
      this.#send(connection, state);
      for (const m of meta) this.#send(connection, m);
    }
  }

  #horizonMeta(channel: Channel): TrackMetaMsg[] {
    const meta: TrackMetaMsg[] = [];
    for (const trackId of channel.horizon(this.config.prefetchHorizonTracks)) {
      const built = this.trackMeta(trackId);
      if (built) meta.push(built);
    }
    return meta;
  }

  /** Manifest row → wire message. Paths become URLs here and nowhere else. */
  trackMeta(trackId: string): TrackMetaMsg | null {
    const track = this.deps.library.getTrack(trackId);
    if (!track || !track.initPath) return null;

    const segments: SegmentMeta[] = this.deps.library.getSegments(trackId).map((s) => ({
      index: s.index,
      url: mediaUrl(s.path),
      startMs: s.startMs,
      durationMs: s.durationMs,
      bytes: s.bytes,
    }));

    const artPath = track.artPathLarge ?? track.artPathSmall;

    return {
      t: 'trackMeta',
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      durationMs: track.durationMs,
      // Ingest's normalisation plus the DJ's correction, summed here so a
      // client applies one number and never has to know there were two (D11).
      gainDb: track.gainDb + (track.gainTrimDb ?? 0),
      bpm: track.bpm,
      beatGridOffsetMs: track.beatGridOffsetMs,
      initUrl: mediaUrl(track.initPath),
      segments,
      peaksUrl: track.peaksPath ? mediaUrl(track.peaksPath) : null,
      beatsUrl: track.beatsPath ? mediaUrl(track.beatsPath) : null,
      artUrl: artPath ? mediaUrl(artPath) : null,
    };
  }

  #durationOf(trackId: string): number | undefined {
    return this.deps.library.getTrack(trackId)?.durationMs;
  }

  #channelOrError(connection: Connection, channelId: string): Channel | null {
    const channel = this.channels.get(channelId);
    if (!channel) {
      this.#error(connection, 'unknown-channel', 'That channel is not running.');
      return null;
    }
    return channel;
  }

  #error(connection: Connection, code: ErrorCode, message: string): void {
    this.#send(connection, { t: 'error', code, message });
  }

  #send(connection: Connection, message: ServerMessage): void {
    try {
      connection.sink.send(JSON.stringify(message));
    } catch (err) {
      // A dead socket must not take the broadcast loop down with it.
      this.deps.logger.event('warn', 'ws.send-failed', {
        clientId: connection.session.clientId,
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
}

export function mediaUrl(relativePath: string): string {
  return `/media/${relativePath}`;
}


export type { FeedItem };
