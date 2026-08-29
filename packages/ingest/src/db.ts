/**
 * The library manifest — SQLite, and the single source of truth for what has
 * been ingested (Part E step 2).
 *
 * It lives in the ingest package because ingest creates it and owns its shape.
 * The server imports `@disco/ingest/db` read-only: one schema, one migration
 * path, no second definition to drift out of step.
 */

import Database, { type Database as Db } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IngestFailure, SegmentRecord, TrackRecord } from './types.js';

/**
 * Bumped when a change makes previously ingested output stale — a new segment
 * length, a different encoder setting, an extra derived asset. A re-run then
 * redoes tracks that would otherwise be skipped as already done.
 */
export const INGEST_VERSION = 1;

/**
 * 2 — `tracks.gain_trim_db`, the DJ's per-track correction on top of the
 * ingested LUFS gain (D11). Owned by the server, not by ingest, which is why a
 * re-run must never reset it.
 */
const SCHEMA_VERSION = 2;

/** Widest trim the dashboard may store. Beyond this it is a mastering problem. */
export const MAX_GAIN_TRIM_DB = 12;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id                  TEXT PRIMARY KEY,
  content_hash        TEXT NOT NULL UNIQUE,
  source_path         TEXT NOT NULL,
  title               TEXT NOT NULL,
  artist              TEXT NOT NULL,
  album               TEXT,
  duration_ms         REAL NOT NULL,
  sample_rate         INTEGER NOT NULL,
  channels            INTEGER NOT NULL,
  integrated_lufs     REAL,
  true_peak_db        REAL,
  gain_db             REAL NOT NULL,
  -- Set from the dashboard, never by ingest. Defaulted rather than nullable so
  -- every read is a number and no caller has to remember the fallback.
  gain_trim_db        REAL NOT NULL DEFAULT 0,
  bpm                 REAL,
  beat_grid_offset_ms REAL,
  beat_count          INTEGER NOT NULL DEFAULT 0,
  init_path           TEXT,
  peaks_path          TEXT,
  beats_path          TEXT,
  art_path_small      TEXT,
  art_path_large      TEXT,
  ingested_at         INTEGER NOT NULL,
  ingest_version      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS segments (
  track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  path        TEXT NOT NULL,
  start_ms    REAL NOT NULL,
  duration_ms REAL NOT NULL,
  bytes       INTEGER NOT NULL,
  PRIMARY KEY (track_id, idx)
);

CREATE TABLE IF NOT EXISTS ingest_failures (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path  TEXT NOT NULL,
  content_hash TEXT,
  stage        TEXT NOT NULL,
  message      TEXT NOT NULL,
  at           INTEGER NOT NULL
);

-- The dashboard's list is sorted and searched on these (D10: library size is a
-- DJ-tooling question, and thousands of tracks is the assumption).
CREATE INDEX IF NOT EXISTS idx_tracks_artist_title ON tracks(artist, title);
CREATE INDEX IF NOT EXISTS idx_tracks_bpm ON tracks(bpm);
`;

/**
 * A manifest row: everything ingest wrote, plus the fields the server owns.
 *
 * Kept distinct from `TrackRecord` on purpose. `saveTrack` takes the ingest
 * record, so a server-owned column can never be clobbered by a re-run simply
 * because it happened to be on the same object.
 */
export interface TrackRow extends TrackRecord {
  /** DJ correction in dB, applied on top of `gainDb` when the meta is sent. */
  gainTrimDb: number;
}

/** Orders the dashboard offers. BPM sort is how a DJ builds a set (D10). */
export type TrackSort = 'artist' | 'title' | 'bpm' | 'recent';

/**
 * Sort key → SQL fragment.
 *
 * A fixed map, and the only text in a query that is not a bound parameter.
 * Unmatched BPM sorts last rather than first: a track with no detected tempo is
 * not the one being looked for when someone sorts by tempo.
 */
const ORDER_BY: Record<TrackSort, string> = {
  artist: 'artist, title',
  title: 'title, artist',
  bpm: 'bpm IS NULL, bpm, artist, title',
  recent: 'ingested_at DESC, artist, title',
};

export class Library {
  readonly db: Db;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    // WAL so the server can read the manifest while an ingest run is still
    // writing to it — re-ingesting between sets should not lock the dashboard.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.#migrate();
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Bring an existing manifest up to the current schema.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing for a database that already has
   * the table, so a column added after the first ingest run needs this. Driven
   * off `table_info` rather than `user_version` so a manifest from a build that
   * predates versioning is also handled.
   */
  #migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'gain_trim_db')) {
      this.db.exec('ALTER TABLE tracks ADD COLUMN gain_trim_db REAL NOT NULL DEFAULT 0');
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Set the DJ's per-track gain trim (D11).
   *
   * Clamped here as well as at the schema, because this is the last place
   * before a number reaches thirty pairs of headphones. Returns false for an
   * unknown track so the caller can answer rather than silently succeeding.
   */
  setGainTrim(trackId: string, gainTrimDb: number): boolean {
    if (!Number.isFinite(gainTrimDb)) return false;
    const clamped = Math.max(-MAX_GAIN_TRIM_DB, Math.min(MAX_GAIN_TRIM_DB, gainTrimDb));
    const result = this.db
      .prepare('UPDATE tracks SET gain_trim_db = ? WHERE id = ?')
      .run(clamped, trackId);
    return result.changes > 0;
  }

  /** The completed record for a source file, if this exact content is already done. */
  findByContentHash(contentHash: string): TrackRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM tracks WHERE content_hash = ?')
      .get(contentHash) as Record<string, unknown> | undefined;
    return row ? rowToTrack(row) : undefined;
  }

  getTrack(id: string): TrackRow | undefined {
    const row = this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTrack(row) : undefined;
  }

  getSegments(trackId: string): SegmentRecord[] {
    const rows = this.db
      .prepare('SELECT idx, path, start_ms, duration_ms, bytes FROM segments WHERE track_id = ? ORDER BY idx')
      .all(trackId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      index: r['idx'] as number,
      path: r['path'] as string,
      startMs: r['start_ms'] as number,
      durationMs: r['duration_ms'] as number,
      bytes: r['bytes'] as number,
    }));
  }

  countTracks(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;
  }

  /** How many tracks a search matches, so the list can be paged and virtualised. */
  countMatching(q?: string): number {
    const term = q?.trim();
    const row = term
      ? (this.db
          .prepare(
            'SELECT COUNT(*) AS n FROM tracks WHERE title LIKE @like OR artist LIKE @like OR album LIKE @like',
          )
          .get({ like: `%${term}%` }) as { n: number })
      : (this.db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number });
    return row.n;
  }

  /**
   * The dashboard's list.
   *
   * Paged, filtered and sorted in SQL rather than in the client, because the
   * library is thousands of tracks and shipping all of them to a browser to
   * filter is the thing that makes a dashboard unusable at 2 000 rows (D10).
   *
   * The query is parameterised throughout — `q` reaches SQLite as a bound
   * value, never as concatenated text — and the sort is chosen from a fixed map
   * rather than interpolated, so the one part of a query that cannot be a bound
   * parameter is also the one part a caller cannot influence.
   */
  listTracks(
    options: { q?: string; limit?: number; offset?: number; sort?: TrackSort } = {},
  ): TrackRow[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const q = options.q?.trim();
    const orderBy = ORDER_BY[options.sort ?? 'artist'] ?? ORDER_BY.artist;

    const rows = q
      ? (this.db
          .prepare(
            `SELECT * FROM tracks
             WHERE title LIKE @like OR artist LIKE @like OR album LIKE @like
             ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`,
          )
          // Escaping is unnecessary here: `%` or `_` in a search box widens the
          // match, which is a harmless surprise, not an injection.
          .all({ like: `%${q}%`, limit, offset }) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM tracks ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
          .all(limit, offset) as Array<Record<string, unknown>>);

    return rows.map(rowToTrack);
  }

  /**
   * Write a track and its segments as one transaction. A crash mid-run leaves
   * either a complete track or no track — never a half-listed one that the
   * dashboard would offer and the client could not play.
   */
  saveTrack(track: TrackRecord, segments: readonly SegmentRecord[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO tracks (
        id, content_hash, source_path, title, artist, album, duration_ms,
        sample_rate, channels, integrated_lufs, true_peak_db, gain_db, bpm,
        beat_grid_offset_ms, beat_count, init_path, peaks_path, beats_path,
        art_path_small, art_path_large, ingested_at, ingest_version
      ) VALUES (
        @id, @contentHash, @sourcePath, @title, @artist, @album, @durationMs,
        @sampleRate, @channels, @integratedLufs, @truePeakDb, @gainDb, @bpm,
        @beatGridOffsetMs, @beatCount, @initPath, @peaksPath, @beatsPath,
        @artPathSmall, @artPathLarge, @ingestedAt, @ingestVersion
      )
      ON CONFLICT(id) DO UPDATE SET
        source_path = excluded.source_path,
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        duration_ms = excluded.duration_ms,
        sample_rate = excluded.sample_rate,
        channels = excluded.channels,
        integrated_lufs = excluded.integrated_lufs,
        true_peak_db = excluded.true_peak_db,
        gain_db = excluded.gain_db,
        bpm = excluded.bpm,
        beat_grid_offset_ms = excluded.beat_grid_offset_ms,
        beat_count = excluded.beat_count,
        init_path = excluded.init_path,
        peaks_path = excluded.peaks_path,
        beats_path = excluded.beats_path,
        art_path_small = excluded.art_path_small,
        art_path_large = excluded.art_path_large,
        ingested_at = excluded.ingested_at,
        ingest_version = excluded.ingest_version
    `);
    const clearSegments = this.db.prepare('DELETE FROM segments WHERE track_id = ?');
    const insertSegment = this.db.prepare(
      'INSERT INTO segments (track_id, idx, path, start_ms, duration_ms, bytes) VALUES (?, ?, ?, ?, ?, ?)',
    );

    this.db.transaction(() => {
      upsert.run(track as unknown as Record<string, never>);
      clearSegments.run(track.id);
      for (const s of segments) {
        insertSegment.run(track.id, s.index, s.path, s.startMs, s.durationMs, s.bytes);
      }
    })();
  }

  recordFailure(f: IngestFailure): void {
    this.db
      .prepare(
        'INSERT INTO ingest_failures (source_path, content_hash, stage, message, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(f.sourcePath, f.contentHash, f.stage, f.message, f.at);
  }

  /** Failures from this run onwards, for the summary printed at the end. */
  recentFailures(since: number): IngestFailure[] {
    const rows = this.db
      .prepare('SELECT source_path, content_hash, stage, message, at FROM ingest_failures WHERE at >= ? ORDER BY at')
      .all(since) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      sourcePath: r['source_path'] as string,
      contentHash: (r['content_hash'] as string | null) ?? null,
      stage: r['stage'] as string,
      message: r['message'] as string,
      at: r['at'] as number,
    }));
  }
}

function rowToTrack(r: Record<string, unknown>): TrackRow {
  return {
    id: r['id'] as string,
    contentHash: r['content_hash'] as string,
    sourcePath: r['source_path'] as string,
    title: r['title'] as string,
    artist: r['artist'] as string,
    album: (r['album'] as string | null) ?? null,
    durationMs: r['duration_ms'] as number,
    sampleRate: r['sample_rate'] as number,
    channels: r['channels'] as number,
    integratedLufs: (r['integrated_lufs'] as number | null) ?? null,
    truePeakDb: (r['true_peak_db'] as number | null) ?? null,
    gainDb: r['gain_db'] as number,
    gainTrimDb: (r['gain_trim_db'] as number | null) ?? 0,
    bpm: (r['bpm'] as number | null) ?? null,
    beatGridOffsetMs: (r['beat_grid_offset_ms'] as number | null) ?? null,
    beatCount: r['beat_count'] as number,
    initPath: (r['init_path'] as string | null) ?? null,
    peaksPath: (r['peaks_path'] as string | null) ?? null,
    beatsPath: (r['beats_path'] as string | null) ?? null,
    artPathSmall: (r['art_path_small'] as string | null) ?? null,
    artPathLarge: (r['art_path_large'] as string | null) ?? null,
    ingestedAt: r['ingested_at'] as number,
    ingestVersion: r['ingest_version'] as number,
  };
}
