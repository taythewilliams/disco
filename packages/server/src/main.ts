/**
 * Entry point.
 *
 * Run with Node's own env-file loading and nothing else:
 *   node --env-file=.env --import tsx packages/server/src/main.ts
 */

import { serverNow } from '@disco/shared';
import { Library } from '@disco/ingest/db';
import { Comments } from './comments.js';
import { loadEnv } from './env.js';
import { buildApp } from './http.js';
import { Hub } from './hub.js';
import { createLogger } from './log.js';
import { WordFilter } from './profanity.js';
import { VenueStore } from './venue.js';

/**
 * How often timelines advance and stale pending comments expire.
 *
 * Track boundaries do not depend on this: `Channel.tick` pins the next track's
 * start to the previous one's exact end, so a late tick still produces the same
 * schedule for everyone (D6).
 */
const TICK_INTERVAL_MS = 250;

export async function start(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger();

  const library = new Library(`${env.mediaRoot}/disco.db`);
  const comments = new Comments({
    filter: WordFilter.fromFile(process.env['DISCO_WORDLIST_FILE']),
  });

  // The venue profile before the hub, so the room starts with the projector
  // offset that was measured in this room rather than with a zero (D8).
  const venue = new VenueStore({ path: env.venueFile, venue: env.venue, logger });
  const profile = venue.load();

  const hub = new Hub({
    library,
    logger,
    comments,
    now: serverNow,
    config: profile.config,
    crates: profile.crates,
    onConfigChange: (patch) => venue.updateConfig(patch),
    onCratesChange: (crates) => venue.setCrates(crates),
  });

  const app = await buildApp({ env, hub, logger });
  const timer = setInterval(() => hub.tick(), TICK_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.event('info', 'server.shutdown', { signal });
    clearInterval(timer);
    // Settings changed in the last half-second of the set are still settings.
    venue.flush();
    // Comments are ephemeral by decision. Dropping them here makes that
    // explicit rather than incidental (D7).
    comments.clear();
    await app.close();
    library.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.host, port: env.port });
  logger.event('info', 'server.listening', {
    host: env.host,
    port: env.port,
    mediaRoot: env.mediaRoot,
    venue: env.venue,
    projectorOffsetMs: hub.config.projectorOffsetMs,
    tracks: library.countTracks(),
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
