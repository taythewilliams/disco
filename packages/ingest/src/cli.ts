/**
 * `disco-ingest` — the offline pipeline over a music directory (D10).
 *
 * Safe to run repeatedly: work is keyed on file contents, so re-running after a
 * crash, after adding fifty tracks, or after a laptop reboot picks up where it
 * left off. Overnight for a large library, minutes for an addition.
 */

import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SEGMENT_TARGET_MS } from '@disco/shared';
import { hashFile } from './hash.js';
import { Library } from './db.js';
import { DEFAULT_TRANSCODE, ingestTrack, StageError, type IngestContext } from './pipeline.js';
import { mapPool } from './pool.js';
import { Progress } from './progress.js';
import { scanAudioFiles } from './scan.js';
import { toolExists, ToolError } from './proc.js';
import type { SourceFile } from './types.js';

const USAGE = `
disco-ingest <music-directory> [options]

  --media <dir>        Output root (default: ./media)
  --concurrency <n>    Parallel tracks (default: available cores)
  --encoder <name>     AAC encoder: aac, or aac_at for macOS AudioToolbox
  --bitrate <rate>     Audio bitrate (default: 192k)
  --segment-ms <ms>    Target segment length (default: ${SEGMENT_TARGET_MS})
  --force              Re-ingest tracks already in the manifest
  --dry-run            Scan and report, write nothing
  --help
`.trimStart();

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      media: { type: 'string', default: 'media' },
      concurrency: { type: 'string' },
      encoder: { type: 'string', default: DEFAULT_TRANSCODE.encoder },
      bitrate: { type: 'string', default: DEFAULT_TRANSCODE.bitrate },
      'segment-ms': { type: 'string' },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help || positionals.length !== 1) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  // Fail on a missing tool now, with a line saying how to fix it, rather than
  // 400 tracks into a run with a stack trace per file.
  for (const [tool, versionArg, hint] of [
    ['ffmpeg', '-version', 'brew install ffmpeg'],
    ['ffprobe', '-version', 'brew install ffmpeg'],
    ['aubio', '--version', 'brew install aubio'],
  ] as const) {
    if (!(await toolExists(tool, versionArg))) {
      process.stderr.write(`${tool} not found on PATH. Install it with: ${hint}\n`);
      return 1;
    }
  }

  const sourceDir = resolve(positionals[0] as string);
  const mediaRoot = resolve(values.media as string);
  const concurrency = Number(values.concurrency ?? availableParallelism());
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    process.stderr.write('--concurrency must be a positive integer\n');
    return 1;
  }

  process.stdout.write(`Scanning ${sourceDir}\n`);
  const paths = await scanAudioFiles(sourceDir);
  if (paths.length === 0) {
    process.stdout.write('No audio files found.\n');
    return 0;
  }
  process.stdout.write(`Found ${paths.length} audio files\n`);

  if (values['dry-run']) {
    for (const p of paths) process.stdout.write(`  ${p}\n`);
    return 0;
  }

  const library = new Library(`${mediaRoot}/disco.db`);
  const runStartedAt = Date.now();

  const ctx: IngestContext = {
    library,
    mediaRoot,
    transcode: {
      ...DEFAULT_TRANSCODE,
      encoder: values.encoder as string,
      bitrate: values.bitrate as string,
      segmentTargetMs: Number(values['segment-ms'] ?? SEGMENT_TARGET_MS),
    },
    force: values.force === true,
  };

  const progress = new Progress(paths.length, 'Ingesting');
  let ingested = 0;
  let skipped = 0;

  try {
    await mapPool(
      paths,
      async (path) => {
        let source: SourceFile;
        try {
          source = await hashFile(path);
        } catch (err) {
          recordFailure(library, path, null, 'hash', err);
          throw err;
        }

        try {
          const outcome = await ingestTrack(ctx, source);
          if (outcome.status === 'skipped') skipped++;
          else ingested++;
          return outcome;
        } catch (err) {
          const stage = err instanceof StageError ? err.stage : 'unknown';
          recordFailure(library, path, source.contentHash, stage, err);
          throw err;
        }
      },
      {
        concurrency,
        onSettled: (index, error) => {
          progress.tick(error !== null);
          if (error) progress.note(`  failed: ${paths[index]} — ${describe(error)}`);
        },
      },
    );

    progress.finish();

    const failures = library.recentFailures(runStartedAt);
    process.stdout.write(
      `${ingested} ingested, ${skipped} already done, ${failures.length} failed. ` +
        `Library now holds ${library.countTracks()} tracks.\n`,
    );
    if (failures.length > 0) {
      // Recorded in the manifest too, so a long overnight run can be reviewed
      // after the terminal has scrolled away.
      process.stdout.write('Failures are in the ingest_failures table of the manifest.\n');
    }
    return 0;
  } finally {
    library.close();
  }
}

function recordFailure(
  library: Library,
  sourcePath: string,
  contentHash: string | null,
  stage: string,
  err: unknown,
): void {
  library.recordFailure({
    sourcePath,
    contentHash,
    stage,
    message: describe(err),
    at: Date.now(),
  });
}

function describe(err: unknown): string {
  if (err instanceof StageError) return `${err.stage}: ${err.message}`;
  if (err instanceof ToolError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

// Run only when this file is the entry point, so the tests can import `main`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${describe(err)}\n`);
      process.exit(1);
    },
  );
}
