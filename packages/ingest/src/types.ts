/** Shapes passed between ingest stages and into the manifest. */

export interface SourceFile {
  path: string;
  /** SHA-256 of the file contents. The idempotency key for the whole pipeline. */
  contentHash: string;
  sizeBytes: number;
}

export interface ProbeResult {
  durationMs: number;
  sampleRate: number;
  channels: number;
  codec: string;
  title: string;
  artist: string;
  album: string | null;
  hasCoverArt: boolean;
}

export interface LoudnessResult {
  /** EBU R128 integrated loudness. */
  integratedLufs: number;
  /** True peak in dBTP, used to stop normalisation gain from clipping. */
  truePeakDb: number;
  loudnessRange: number;
}

export interface BeatResult {
  bpm: number | null;
  /** Position of the first detected beat. The projector's phase reference (D8). */
  beatGridOffsetMs: number | null;
  /** Every beat, in ms. Real recordings drift, so a grid beats a single tempo. */
  beats: number[];
}

export interface SegmentRecord {
  index: number;
  /** Path relative to the media root, as served. */
  path: string;
  startMs: number;
  durationMs: number;
  bytes: number;
}

export interface TrackRecord {
  id: string;
  contentHash: string;
  sourcePath: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number;
  sampleRate: number;
  channels: number;
  integratedLufs: number | null;
  truePeakDb: number | null;
  /** Gain to reach the target loudness, already limited against clipping. */
  gainDb: number;
  bpm: number | null;
  beatGridOffsetMs: number | null;
  beatCount: number;
  initPath: string | null;
  peaksPath: string | null;
  beatsPath: string | null;
  artPathSmall: string | null;
  artPathLarge: string | null;
  ingestedAt: number;
  ingestVersion: number;
}

export interface IngestFailure {
  sourcePath: string;
  contentHash: string | null;
  stage: string;
  message: string;
  at: number;
}
