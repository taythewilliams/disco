/**
 * The protocol contract.
 *
 * Defined once, imported by both ends (D12). A change that breaks a client
 * fails to typecheck rather than failing at 11pm. Every inbound message is
 * parsed against these schemas and unknown types are rejected outright rather
 * than ignored — an ignored message is an unlogged one.
 */

import { z } from 'zod';
import { COMMENT_MAX_LENGTH } from './constants.js';

// ─── Primitives ─────────────────────────────────────────────────────────────

/**
 * Identifiers are a deliberately narrow charset: no dots, no slashes, no
 * separators of any kind. Track IDs reach the filesystem when a segment is
 * served, and the cheapest place to make traversal impossible is here, before
 * any handler sees the value. The resolved path is checked again at the point
 * of use — this is the first of two gates, not the only one (D12, OWASP A01).
 */
export const SafeId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'identifiers are [A-Za-z0-9_-] only');

export const ChannelId = SafeId;
export const TrackId = SafeId;
export const ClientId = SafeId;
export const CommentId = SafeId;

/**
 * Three roles, resolved at the WebSocket upgrade.
 *
 * `display` exists so the projector is not the DJ. It runs on a machine on the
 * trusted network, but it is a screen in a public room and there is no reason
 * for it to be able to skip a track — it reads state, track metadata and the
 * moderated feed, and can send nothing that changes anything (D8).
 */
export const Role = z.enum(['guest', 'dj', 'display']);
export type Role = z.infer<typeof Role>;

export const EngineName = z.enum(['webaudio', 'mediaelement']);
export type EngineName = z.infer<typeof EngineName>;

export const ModerationMode = z.enum(['review', 'open']);
export type ModerationMode = z.infer<typeof ModerationMode>;

export const EngineOverride = z.enum(['auto', 'webaudio', 'mediaelement']);
export type EngineOverride = z.infer<typeof EngineOverride>;

/**
 * The same values as arrays, for the dashboard's selects.
 *
 * Derived from the schemas rather than written twice: a mode the server would
 * reject can then never appear in a dropdown that offers it.
 */
export const MODERATION_MODES = ModerationMode.options;
export const ENGINE_OVERRIDES = EngineOverride.options;

/**
 * How much of a track a client holds (D5).
 *
 * Reported by every guest and aggregated into the dashboard's "28/30 ready"
 * bar. Defined here rather than in `segments.ts` so the wire shape and the
 * function that computes it cannot drift apart.
 */
export const ReadinessState = z.enum(['ready', 'partial', 'not-ready']);
export type ReadinessState = z.infer<typeof ReadinessState>;

/** A server-time reading. Milliseconds on the monotonic server timeline (D9). */
export const ServerTime = z.number().finite();

// ─── Runtime config (D11) ───────────────────────────────────────────────────

/**
 * Partial by design: `config` messages carry deltas, and `config.set` from the
 * dashboard patches rather than replaces. `strict()` means a typo in a key name
 * is an error instead of a silently ignored setting.
 */
export const RuntimeConfigPatch = z
  .object({
    prefetchHorizonTracks: z.number().int().min(1).max(20),
    minLeadTimeMs: z.number().int().min(0).max(3_600_000),
    maxConcurrentSegmentDownloads: z.number().int().min(1).max(200),
    clockResyncIntervalMs: z.number().int().min(1_000).max(300_000),
    driftDeadbandMs: z.number().min(0).max(1_000),
    driftRescheduleThresholdMs: z.number().min(1).max(5_000),
    devicePresetMs: z.record(z.string(), z.number().min(-500).max(1_000)),
    engineOverride: EngineOverride,
    mediaElementSeekBiasMs: z.number().min(-200).max(500),
    projectorOffsetMs: z.number().min(-1_000).max(1_000),
    moderationMode: ModerationMode,
    commentPendingExpiryMs: z.number().int().min(10_000).max(3_600_000),
    commentsPerMinute: z.number().int().min(0).max(120),
    pingsPerMinute: z.number().int().min(1).max(1_000),
    feedHidden: z.boolean(),
    strings: z.record(z.string(), z.string().max(300)),
  })
  .strict()
  .partial();
export type RuntimeConfigPatch = z.infer<typeof RuntimeConfigPatch>;

// ─── Shared payload shapes ──────────────────────────────────────────────────

export const SegmentMeta = z.object({
  index: z.number().int().min(0),
  url: z.string(),
  /** Offset of this segment within the track. */
  startMs: z.number().min(0),
  /** Exact duration in frames, converted to ms. Nominal length is a target only. */
  durationMs: z.number().positive(),
  bytes: z.number().int().min(0),
});
export type SegmentMeta = z.infer<typeof SegmentMeta>;

export const FeedItem = z.object({
  id: CommentId,
  /** Already sanitised server-side. Renderers still escape on output (D7). */
  text: z.string().max(COMMENT_MAX_LENGTH),
  at: ServerTime,
});
export type FeedItem = z.infer<typeof FeedItem>;

export const ErrorCode = z.enum([
  'unauthorised',
  'bad-message',
  'rate-limited',
  'unknown-channel',
  'unknown-track',
  'comment-rejected',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

// ─── Guest → server ─────────────────────────────────────────────────────────

/** Clock sync. Rate-limited hard: it is the cheapest message to flood (D12). */
export const PingMsg = z.object({ t: z.literal('ping'), t0: z.number().finite() });

export const SubscribeMsg = z.object({ t: z.literal('subscribe'), channelId: ChannelId });

/** One track's readiness on one client. The unit the dashboard's bar counts. */
export const TrackReadiness = z.object({ trackId: TrackId, state: ReadinessState });
export type TrackReadiness = z.infer<typeof TrackReadiness>;

/**
 * No PII anywhere: the client ID is random per page load and the payload
 * carries measurements only (D12).
 */
export const TelemetryMsg = z.object({
  t: z.literal('telemetry'),
  offsetMs: z.number().finite(),
  rttMs: z.number().min(0),
  driftMs: z.number().finite(),
  calibrationMs: z.number().finite(),
  engine: EngineName,
  bufferSec: z.number().min(0),
  /**
   * Whether this client is actually hearing audio right now.
   *
   * Two things read it. The dashboard shows who is listening rather than who is
   * merely connected, and the server's segment admission control lets listeners
   * past joiners: a rush at the door must never starve the dance floor (D4).
   */
  playing: z.boolean(),
  /**
   * Readiness across the horizon, which is at most a handful of tracks (D5).
   * Bounded well above `prefetchHorizonTracks`' own ceiling so a config change
   * cannot silently start truncating the dashboard's readiness bars.
   */
  ready: z.array(TrackReadiness).max(24),
});

/** Length is enforced again here, not only in the field (D7). */
export const CommentMsg = z.object({
  t: z.literal('comment'),
  text: z.string().min(1).max(COMMENT_MAX_LENGTH * 4),
});

// ─── DJ → server ────────────────────────────────────────────────────────────
// Every one of these is authorisation-checked server-side. Hiding the UI is
// not enforcement: assume dev tools are open and `{t:"transport.skip"}` is
// being sent by hand (D12, OWASP A01).

export const QueueSetMsg = z.object({
  t: z.literal('queue.set'),
  channelId: ChannelId,
  trackIds: z.array(TrackId).max(500),
});

export const TransportPlayMsg = z.object({
  t: z.literal('transport.play'),
  channelId: ChannelId,
  trackId: TrackId.optional(),
  /** Omitted means "as soon as the lead time allows". */
  atServerTime: ServerTime.optional(),
  fromPositionMs: z.number().min(0).optional(),
});

export const TransportPauseMsg = z.object({ t: z.literal('transport.pause'), channelId: ChannelId });
export const TransportSkipMsg = z.object({ t: z.literal('transport.skip'), channelId: ChannelId });
export const TransportSeekMsg = z.object({
  t: z.literal('transport.seek'),
  channelId: ChannelId,
  positionMs: z.number().min(0),
});

/**
 * Per-track gain trim, on top of the ingested LUFS gain (D10, D11).
 *
 * Ingest normalises every track to the same integrated loudness, which is right
 * for the great majority and wrong for the handful where the measurement and
 * the dance floor disagree. The trim is a correction the DJ applies once and
 * keeps: it is stored in the manifest, not in the venue profile, because it
 * belongs to the track wherever it is played.
 *
 * Bounded at ±12 dB. Wider is not a trim, it is a mastering problem, and a
 * slider that can silence or blow out a room is a hazard at 1am.
 */
export const TrackGainMsg = z.object({
  t: z.literal('track.gain'),
  trackId: TrackId,
  gainTrimDb: z.number().min(-12).max(12),
});

/**
 * A saved crate: a named list of track IDs (D10, "library size is a DJ-tooling
 * question"). Names are DJ-authored and DJ-visible only, and are still held to
 * a narrow charset — a name reaches a JSON file on disk and a React key, and
 * neither is a place to discover what a control character does.
 */
export const CrateName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9 _-]+$/, 'crate names are letters, digits, spaces, _ and - only');

export const Crate = z.object({ name: CrateName, trackIds: z.array(TrackId).max(500) });
export type Crate = z.infer<typeof Crate>;

export const CrateSaveMsg = z.object({
  t: z.literal('crate.save'),
  name: CrateName,
  trackIds: z.array(TrackId).max(500),
});

export const CrateDeleteMsg = z.object({ t: z.literal('crate.delete'), name: CrateName });

export const CommentApproveMsg = z.object({ t: z.literal('comment.approve'), id: CommentId });
export const CommentRejectMsg = z.object({ t: z.literal('comment.reject'), id: CommentId });
export const CommentRemoveMsg = z.object({ t: z.literal('comment.remove'), id: CommentId });

/** The panic control. One tap, no navigation (D7). */
export const FeedHideMsg = z.object({ t: z.literal('feed.hide'), hidden: z.boolean() });

export const ConfigSetMsg = z.object({ t: z.literal('config.set'), patch: RuntimeConfigPatch });

export const ResyncMsg = z.object({
  t: z.literal('resync'),
  /** Omitted means every channel. */
  channelId: ChannelId.optional(),
});

export const ClientMessage = z.discriminatedUnion('t', [
  PingMsg,
  SubscribeMsg,
  TelemetryMsg,
  CommentMsg,
  QueueSetMsg,
  TransportPlayMsg,
  TransportPauseMsg,
  TransportSkipMsg,
  TransportSeekMsg,
  TrackGainMsg,
  CrateSaveMsg,
  CrateDeleteMsg,
  CommentApproveMsg,
  CommentRejectMsg,
  CommentRemoveMsg,
  FeedHideMsg,
  ConfigSetMsg,
  ResyncMsg,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ClientMessageType = ClientMessage['t'];

// ─── Server → client ────────────────────────────────────────────────────────

export const HelloMsg = z.object({
  t: z.literal('hello'),
  protocolVersion: z.number().int(),
  clientId: ClientId,
  role: Role,
  serverTime: ServerTime,
  /** Channels this connection may act on. v1 grants `["*"]` to the DJ (D3). */
  channels: z.array(z.string()),
  config: RuntimeConfigPatch,
});

export const PongMsg = z.object({
  t: z.literal('pong'),
  /** Echoed back untouched so the client can pair it with its send. */
  t0: z.number().finite(),
  /** Server time at receipt. */
  t1: ServerTime,
});

/**
 * The one message that matters. Any client, on any channel, joining at any
 * moment computes `position = serverNow - startAtServerTime` and knows exactly
 * where to be (v4 Part 2).
 */
export const StateMsg = z.object({
  t: z.literal('state'),
  channelId: ChannelId,
  trackId: TrackId.nullable(),
  startAtServerTime: ServerTime,
  paused: z.boolean(),
  pausedAtPosition: z.number().min(0).nullable(),
  queue: z.array(TrackId),
});
export type StateMsg = z.infer<typeof StateMsg>;

export const TrackMetaMsg = z.object({
  t: z.literal('trackMeta'),
  trackId: TrackId,
  title: z.string(),
  artist: z.string(),
  durationMs: z.number().positive(),
  /** Gain to reach the target loudness, applied client-side (D10). */
  gainDb: z.number(),
  bpm: z.number().positive().nullable(),
  /** Position of the first beat; the projector's visuals key off this (D8). */
  beatGridOffsetMs: z.number().nullable(),
  /**
   * The fMP4 initialisation segment. A fragment is not independently
   * decodable — the client prepends this to each one before `decodeAudioData`.
   */
  initUrl: z.string(),
  segments: z.array(SegmentMeta),
  peaksUrl: z.string().nullable(),
  /** Full beat grid for the projector; a single BPM drifts over five minutes. */
  beatsUrl: z.string().nullable(),
  artUrl: z.string().nullable(),
});
export type TrackMetaMsg = z.infer<typeof TrackMetaMsg>;

export const ConfigMsg = z.object({ t: z.literal('config'), patch: RuntimeConfigPatch });

/** Dashboard and display only. Guests submit to the feed; they do not read it. */
export const FeedMsg = z.object({
  t: z.literal('feed'),
  /** Cleared for the projector. */
  items: z.array(FeedItem),
  /** Awaiting the DJ in review mode. The dashboard's card stack (D7). */
  pending: z.array(FeedItem),
  /** True while the panic control is engaged. */
  hidden: z.boolean(),
});

/** Saved crates, sent to the dashboard only. Not something a projector renders. */
export const CratesMsg = z.object({ t: z.literal('crates'), items: z.array(Crate) });

/** Message strings are server-driven so wording can be fixed mid-event (D11). */
export const ErrorMsg = z.object({
  t: z.literal('error'),
  code: ErrorCode,
  message: z.string(),
});

export const ServerMessage = z.discriminatedUnion('t', [
  HelloMsg,
  PongMsg,
  StateMsg,
  TrackMetaMsg,
  ConfigMsg,
  FeedMsg,
  CratesMsg,
  ErrorMsg,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type ServerMessageType = ServerMessage['t'];

// ─── Authorisation table ────────────────────────────────────────────────────

/** Every role that may read the timeline. Sending these changes nothing. */
const READERS = ['guest', 'dj', 'display'] as const;

/**
 * Which roles may send each inbound message. Kept as data, next to the schemas,
 * so the answer to "what can a guest send?" is one table rather than a
 * scattering of guards. The server reads this in a single `requireRole()` at
 * the top of dispatch; adding a message type without an entry fails to
 * typecheck.
 *
 * There is no implicit widening — no role inherits another's grants. Every
 * mutating message names `dj` and nothing else.
 */
export const ALLOWED_ROLES: Record<ClientMessageType, readonly Role[]> = {
  ping: READERS,
  subscribe: READERS,
  telemetry: READERS,
  // Guests only. The DJ moderates the feed and must not also be able to post
  // into it, which would route around the moderation it is running.
  comment: ['guest'],
  'queue.set': ['dj'],
  'transport.play': ['dj'],
  'transport.pause': ['dj'],
  'transport.skip': ['dj'],
  'transport.seek': ['dj'],
  'track.gain': ['dj'],
  'crate.save': ['dj'],
  'crate.delete': ['dj'],
  'comment.approve': ['dj'],
  'comment.reject': ['dj'],
  'comment.remove': ['dj'],
  'feed.hide': ['dj'],
  'config.set': ['dj'],
  resync: ['dj'],
};

export function maySend(role: Role, type: ClientMessageType): boolean {
  return ALLOWED_ROLES[type].includes(role);
}

/** Roles the moderated comment feed is sent to. Guests submit; they do not read (D7). */
export function mayReadFeed(role: Role): boolean {
  return role === 'dj' || role === 'display';
}

/**
 * Crates are DJ tooling. The projector has no use for them and a guest has no
 * business seeing the catalogue, so the list goes to one role only.
 */
export function mayReadCrates(role: Role): boolean {
  return role === 'dj';
}

// ─── Parsing ────────────────────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; detail: string };

/**
 * Parse an inbound frame. Anything that is not valid JSON, not an object, or
 * not a known message type is rejected with `bad-message` — never ignored, so
 * every rejection is countable.
 */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'bad-message', detail: 'malformed JSON' };
  }
  const parsed = ClientMessage.safeParse(json);
  if (!parsed.success) {
    // The detail is for the server log, not the wire: it can echo field names
    // and must not be handed back to an unauthenticated sender verbatim.
    return { ok: false, code: 'bad-message', detail: parsed.error.issues[0]?.message ?? 'invalid' };
  }
  return { ok: true, value: parsed.data };
}

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'bad-message', detail: 'malformed JSON' };
  }
  const parsed = ServerMessage.safeParse(json);
  if (!parsed.success) {
    return { ok: false, code: 'bad-message', detail: parsed.error.issues[0]?.message ?? 'invalid' };
  }
  return { ok: true, value: parsed.data };
}
