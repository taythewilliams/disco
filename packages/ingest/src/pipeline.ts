/**
 * The per-track pipeline.
 *
 * Every stage for one track, in order, writing into a staging directory that is
 * renamed into place only once the whole track has succeeded. That rename is
 * what makes the run resumable: a directory either holds a complete track or
 * does not exist, so a crash halfway through 2 000 files costs one track's work
 * and nothing else (Part E step 2).
 */

import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TARGET_LUFS } from '@disco/shared';
import {
  computePeaks,
  decodeForAnalysis,
  detectBeats,
  writeJson,
} from './analysis.js';
import { extractArtwork } from './artwork.js';
import { INGEST_VERSION, type Library } from './db.js';
import { trackIdFromHash } from './hash.js';
import { analyseLoudness, gainForTarget } from './loudness.js';
import { probeSource } from './probe.js';
import { DEFAULT_TRANSCODE, INIT_SEGMENT_NAME, transcodeToSegments, type TranscodeOptions } from './transcode.js';
import type { SegmentRecord, SourceFile, TrackRecord } from './types.js';

export class StageError extends Error {
  constructor(
    readonly stage: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'StageError';
    this.cause = cause;
  }
}

async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new StageError(name, err);
  }
}

export interface IngestContext {
  library: Library;
  mediaRoot: string;
  transcode: TranscodeOptions;
  force: boolean;
}

export type IngestOutcome =
  | { status: 'ingested'; track: TrackRecord; segments: SegmentRecord[] }
  | { status: 'skipped'; track: TrackRecord };

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Whether an existing manifest row can be trusted, or the track has to be redone.
 *
 * The row alone is not enough — someone clearing `media/` would otherwise leave
 * a library full of entries the dashboard offers and no client can play — so
 * the init segment and every fragment are checked on disk.
 */
async function isComplete(
  ctx: IngestContext,
  existing: TrackRecord,
  segments: readonly SegmentRecord[],
): Promise<boolean> {
  if (existing.ingestVersion !== INGEST_VERSION) return false;
  if (segments.length === 0) return false;
  if (!existing.initPath || !(await exists(join(ctx.mediaRoot, existing.initPath)))) return false;
  for (const s of segments) {
    if (!(await exists(join(ctx.mediaRoot, s.path)))) return false;
  }
  return true;
}

export async function ingestTrack(ctx: IngestContext, source: SourceFile): Promise<IngestOutcome> {
  const id = trackIdFromHash(source.contentHash);

  if (!ctx.force) {
    const existing = ctx.library.findByContentHash(source.contentHash);
    if (existing) {
      const segments = ctx.library.getSegments(existing.id);
      if (await isComplete(ctx, existing, segments)) return { status: 'skipped', track: existing };
    }
  }

  const relativeDir = `tracks/${id}`;
  const finalDir = join(ctx.mediaRoot, relativeDir);
  const stagingDir = `${finalDir}.partial`;
  const wavPath = join(stagingDir, 'analysis.wav');

  // Clear both: a previous attempt may have left staging behind, and a forced
  // re-run has to replace whatever is currently published.
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    const probe = await stage('probe', () => probeSource(source.path));
    const loudness = await stage('loudness', () => analyseLoudness(source.path));
    const { segments, totalDurationMs } = await stage('transcode', () =>
      transcodeToSegments(source.path, stagingDir, relativeDir, ctx.transcode),
    );

    await stage('decode', () => decodeForAnalysis(source.path, wavPath));
    const beats = await stage('beats', () => detectBeats(wavPath));
    const peaks = await stage('peaks', () => computePeaks(wavPath));

    await stage('write-analysis', async () => {
      await writeJson(join(stagingDir, 'peaks.json'), peaks);
      await writeJson(join(stagingDir, 'beats.json'), {
        version: 1,
        bpm: beats.bpm,
        offsetMs: beats.beatGridOffsetMs,
        beatsMs: beats.beats,
      });
    });

    const artwork = await stage('artwork', () =>
      extractArtwork(source.path, stagingDir, relativeDir),
    );

    // The analysis WAV is scratch — tens of megabytes a track, and nothing
    // downstream reads it.
    await rm(wavPath, { force: true });

    const track: TrackRecord = {
      id,
      contentHash: source.contentHash,
      sourcePath: source.path,
      title: probe.title,
      artist: probe.artist,
      album: probe.album,
      // The encode's own length, not the source's: the schedule is built from
      // these segments, and a container's declared duration can disagree.
      durationMs: totalDurationMs,
      sampleRate: ctx.transcode.sampleRate,
      channels: ctx.transcode.channels,
      integratedLufs: loudness.integratedLufs,
      truePeakDb: loudness.truePeakDb,
      gainDb: gainForTarget(loudness, TARGET_LUFS),
      bpm: beats.bpm,
      beatGridOffsetMs: beats.beatGridOffsetMs,
      beatCount: beats.beats.length,
      initPath: `${relativeDir}/${INIT_SEGMENT_NAME}`,
      peaksPath: `${relativeDir}/peaks.json`,
      beatsPath: `${relativeDir}/beats.json`,
      artPathSmall: artwork.smallPath,
      artPathLarge: artwork.largePath,
      ingestedAt: Date.now(),
      ingestVersion: INGEST_VERSION,
    };

    await stage('publish', async () => {
      await rm(finalDir, { recursive: true, force: true });
      await rename(stagingDir, finalDir);
    });

    // Manifest last: nothing is listed until its files are in place.
    ctx.library.saveTrack(track, segments);
    return { status: 'ingested', track, segments };
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

export { DEFAULT_TRANSCODE };
