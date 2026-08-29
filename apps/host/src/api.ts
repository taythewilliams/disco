/**
 * HTTP calls the dashboard and the projector make.
 *
 * The session cookie is httpOnly, so nothing here touches a credential after
 * the initial exchange — `credentials: 'same-origin'` lets the browser attach
 * it and this code never sees it.
 */

import type { ReadinessState, Role } from '@disco/shared';

export interface LibraryTrack {
  trackId: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number;
  bpm: number | null;
  /** Loudness gain from ingest, before the DJ's trim. */
  gainDb: number;
  /** The DJ's correction, kept separate here so the slider shows the trim (D11). */
  gainTrimDb: number;
}

export interface TelemetryRow {
  clientId: string;
  role: string;
  channelId: string | null;
  offsetMs?: number;
  rttMs?: number;
  driftMs?: number;
  calibrationMs?: number;
  engine?: string;
  bufferSec?: number;
  playing?: boolean;
  ready?: Array<{ trackId: string; state: ReadinessState }>;
  at?: number;
}

/** One readiness bar: "28/30 ready" for a track in the horizon (D5). */
export interface ReadinessRow {
  trackId: string;
  ready: number;
  partial: number;
  notReady: number;
  listeners: number;
  /** When the room first saw the track, for the lead-time badge (D5). */
  publishedAtServerTime: number | null;
}

export interface DownloadStats {
  inFlight: number;
  queuedListeners: number;
  queuedJoiners: number;
  /** Transfers that had to wait for a slot, cumulative. */
  queuedTotal: number;
  admittedOverCapacity: number;
  /** Requests refused because the queue was full. */
  refused: number;
  peakInFlight: number;
}

export interface TelemetryResponse {
  clients: TelemetryRow[];
  readiness: ReadinessRow[];
  downloads: DownloadStats;
  venue: string;
}

export type TrackSort = 'artist' | 'title' | 'bpm' | 'recent';

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`${response.status}`);
  return (await response.json()) as T;
}

/**
 * Exchange a credential for a session cookie.
 *
 * Posted, never put in a query string: URLs land in proxy logs, browser history
 * and `Referer` headers (D12).
 */
export async function signIn(code: string): Promise<{ role: Role; clientId: string }> {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new Error(response.status === 429 ? 'Too many attempts.' : 'Wrong code.');
  return (await response.json()) as { role: Role; clientId: string };
}

/**
 * The role this browser already holds, if any.
 *
 * The cookie is httpOnly, so the only way to find out is to ask. Without this,
 * a DJ who reloads mid-set is asked for the credential again at exactly the
 * moment they have least attention to spare — and a projector that reboots
 * shows a sign-in form on a wall in front of a room.
 */
export async function currentRole(): Promise<Role | null> {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    if (!response.ok) return null;
    return ((await response.json()) as { role: Role }).role;
  } catch {
    return null;
  }
}

export function fetchLibrary(
  q: string,
  options: { limit?: number; offset?: number; sort?: TrackSort } = {},
): Promise<{ tracks: LibraryTrack[]; total: number }> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 200),
    offset: String(options.offset ?? 0),
    sort: options.sort ?? 'artist',
  });
  if (q.trim()) params.set('q', q.trim());
  return getJson(`/api/library?${params.toString()}`);
}

export function fetchTelemetry(): Promise<TelemetryResponse> {
  return getJson('/api/telemetry');
}
