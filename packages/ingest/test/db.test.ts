import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INGEST_VERSION, Library } from '../src/db.js';
import type { SegmentRecord, TrackRecord } from '../src/types.js';

let dir: string;
let library: Library;

const track = (over: Partial<TrackRecord> = {}): TrackRecord => ({
  id: 'a3a23b67f9c757b182311d64c08a5d62',
  contentHash: 'a3a23b67f9c757b182311d64c08a5d62deadbeefdeadbeefdeadbeefdeadbeef',
  sourcePath: '/music/track.flac',
  title: 'Test Kick 120',
  artist: 'Disco Test',
  album: null,
  durationMs: 62_023.22,
  sampleRate: 44_100,
  channels: 2,
  integratedLufs: -16.22,
  truePeakDb: -2.85,
  gainDb: 1.85,
  bpm: 120.4,
  beatGridOffsetMs: 1750.159,
  beatCount: 121,
  initPath: 'tracks/a3a23b67f9c757b182311d64c08a5d62/init.mp4',
  peaksPath: 'tracks/a3a23b67f9c757b182311d64c08a5d62/peaks.json',
  beatsPath: 'tracks/a3a23b67f9c757b182311d64c08a5d62/beats.json',
  artPathSmall: null,
  artPathLarge: null,
  ingestedAt: 1_724_832_000_000,
  ingestVersion: INGEST_VERSION,
  ...over,
});

const segments: SegmentRecord[] = [
  { index: 0, path: 'tracks/x/seg-00000.m4s', startMs: 0, durationMs: 25_007.891, bytes: 567_431 },
  {
    index: 1,
    path: 'tracks/x/seg-00001.m4s',
    startMs: 25_007.891,
    durationMs: 25_007.891,
    bytes: 568_581,
  },
];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'disco-db-'));
  library = new Library(join(dir, 'nested', 'disco.db'));
});

afterEach(async () => {
  library.close();
  await rm(dir, { recursive: true, force: true });
});

describe('Library', () => {
  it('creates the manifest and its parent directory', () => {
    expect(library.countTracks()).toBe(0);
  });

  it('round-trips a track and its segments', () => {
    const t = track();
    library.saveTrack(t, segments);

    // `toMatchObject` rather than `toEqual`: a manifest row is the ingest
    // record plus the columns the server owns, and `gainTrimDb` is one of them.
    expect(library.getTrack(t.id)).toMatchObject(t);
    expect(library.getTrack(t.id)?.gainTrimDb).toBe(0);
    expect(library.findByContentHash(t.contentHash)).toMatchObject(t);
    expect(library.getSegments(t.id)).toEqual(segments);
  });

  it('keeps segment ordering by index, not insertion order', () => {
    const t = track();
    library.saveTrack(t, [segments[1] as SegmentRecord, segments[0] as SegmentRecord]);
    expect(library.getSegments(t.id).map((s) => s.index)).toEqual([0, 1]);
  });

  it('replaces rather than accumulates segments on re-ingest', () => {
    // A forced re-run at a different segment length must not leave the old
    // fragments listed alongside the new ones.
    const t = track();
    library.saveTrack(t, segments);
    library.saveTrack(t, [segments[0] as SegmentRecord]);
    expect(library.getSegments(t.id)).toHaveLength(1);
  });

  it('preserves millisecond precision on durations', () => {
    // Durations are summed across a track, so a REAL column rather than an
    // integer one is load-bearing.
    const t = track();
    library.saveTrack(t, segments);
    expect(library.getSegments(t.id)[0]?.durationMs).toBe(25_007.891);
    expect(library.getTrack(t.id)?.durationMs).toBe(62_023.22);
  });

  it('returns undefined for a track it has never seen', () => {
    expect(library.getTrack('deadbeef')).toBeUndefined();
    expect(library.findByContentHash('deadbeef')).toBeUndefined();
    expect(library.getSegments('deadbeef')).toEqual([]);
  });

  it('keeps nullable analysis fields null rather than coercing them', () => {
    // An ambient track with no detectable tempo has to stay null: a zero BPM
    // would sort into the dashboard's list as if it were real.
    const t = track({ bpm: null, beatGridOffsetMs: null, beatCount: 0, integratedLufs: null });
    library.saveTrack(t, segments);
    const loaded = library.getTrack(t.id);
    expect(loaded?.bpm).toBeNull();
    expect(loaded?.beatGridOffsetMs).toBeNull();
    expect(loaded?.integratedLufs).toBeNull();
  });

  it('records failures without stopping and reports them by run', () => {
    library.recordFailure({
      sourcePath: '/music/broken.mp3',
      contentHash: null,
      stage: 'probe',
      message: 'no audio stream',
      at: 1_000,
    });
    library.recordFailure({
      sourcePath: '/music/later.mp3',
      contentHash: 'abc',
      stage: 'transcode',
      message: 'encoder failed',
      at: 3_000,
    });

    expect(library.recentFailures(0)).toHaveLength(2);
    expect(library.recentFailures(2_000).map((f) => f.stage)).toEqual(['transcode']);
  });

  it('stores a gain trim and clamps it to something a room can survive', () => {
    const t = track();
    library.saveTrack(t, segments);

    expect(library.setGainTrim(t.id, -3.5)).toBe(true);
    expect(library.getTrack(t.id)?.gainTrimDb).toBe(-3.5);

    library.setGainTrim(t.id, 400);
    expect(library.getTrack(t.id)?.gainTrimDb).toBe(12);
    library.setGainTrim(t.id, -400);
    expect(library.getTrack(t.id)?.gainTrimDb).toBe(-12);
  });

  it('refuses a gain trim for a track it does not have', () => {
    expect(library.setGainTrim('deadbeef', 2)).toBe(false);
    expect(library.setGainTrim(track().id, Number.NaN)).toBe(false);
  });

  it('keeps the gain trim through a re-ingest', () => {
    // The trim belongs to the track and is set from the dashboard. Re-running
    // ingest after a library change must not quietly undo a correction the DJ
    // made mid-set (D11).
    const t = track();
    library.saveTrack(t, segments);
    library.setGainTrim(t.id, -2);
    library.saveTrack({ ...t, title: 'Retagged' }, segments);
    expect(library.getTrack(t.id)?.gainTrimDb).toBe(-2);
    expect(library.getTrack(t.id)?.title).toBe('Retagged');
  });

  it('adds the gain trim column to a manifest written before it existed', () => {
    // The v1 schema, as a database created by an earlier build would have it.
    const legacyPath = join(dir, 'legacy.db');
    const legacy = new Library(legacyPath);
    legacy.saveTrack(track(), segments);
    legacy.db.exec('ALTER TABLE tracks DROP COLUMN gain_trim_db');
    legacy.close();

    const reopened = new Library(legacyPath);
    expect(reopened.getTrack(track().id)?.gainTrimDb).toBe(0);
    expect(reopened.setGainTrim(track().id, 1.5)).toBe(true);
    reopened.close();
  });

  it('sorts and counts for the dashboard list', () => {
    library.saveTrack(track({ id: 'aaa', contentHash: 'h1', artist: 'Zed', title: 'Anthem', bpm: 128 }), segments);
    library.saveTrack(track({ id: 'bbb', contentHash: 'h2', artist: 'Abe', title: 'Zulu', bpm: 90 }), segments);
    library.saveTrack(track({ id: 'ccc', contentHash: 'h3', artist: 'Mid', title: 'Nada', bpm: null }), segments);

    expect(library.listTracks({ sort: 'artist' }).map((t) => t.id)).toEqual(['bbb', 'ccc', 'aaa']);
    expect(library.listTracks({ sort: 'title' }).map((t) => t.id)).toEqual(['aaa', 'ccc', 'bbb']);
    // A track with no detected tempo sorts last, not first: it is not what
    // someone sorting by tempo is looking for.
    expect(library.listTracks({ sort: 'bpm' }).map((t) => t.id)).toEqual(['bbb', 'aaa', 'ccc']);

    expect(library.countMatching()).toBe(3);
    expect(library.countMatching('zu')).toBe(1);
    expect(library.listTracks({ q: 'zu' }).map((t) => t.id)).toEqual(['bbb']);
  });

  it('deletes a tracks segments with the track', () => {
    const t = track();
    library.saveTrack(t, segments);
    library.db.prepare('DELETE FROM tracks WHERE id = ?').run(t.id);
    expect(library.getSegments(t.id)).toEqual([]);
  });
});
