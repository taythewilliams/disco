/**
 * The venue profile — the small amount of state that should outlive a restart
 * (D8, D11).
 *
 * Projector offset is the reason this exists. It is measured once per venue by
 * standing in the room with calibrated headphones and dragging a slider until
 * the pulse matches the beat, and asking someone to redo that because the
 * server was restarted at 9pm is not acceptable. Prefetch depth, the device
 * preset table and the moderation mode earn their place the same way: they are
 * decided before doors and should still be there afterwards.
 *
 * A JSON file rather than a table in the manifest. The manifest belongs to
 * ingest and is rebuilt from source audio; this is operational state, it is a
 * few hundred bytes, and being able to read and hand-edit it at 11pm with the
 * event running is worth more than the tidiness of one store.
 *
 * Deliberately *not* persisted: `feedHidden`. The panic control is a live
 * control, and a server that came back up with the feed still hidden and
 * nobody remembering why would be a mystery at exactly the wrong moment (D7).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Crate, RuntimeConfigPatch, type RuntimeConfig } from '@disco/shared';
import { z } from 'zod';
import type { Logger } from './log.js';

/**
 * Settings that survive a restart.
 *
 * An allowlist, not a denylist: a setting added to the runtime config later is
 * ephemeral until someone decides it belongs to the venue, which is the safer
 * default of the two.
 */
export const PERSISTED_KEYS = [
  'projectorOffsetMs',
  'devicePresetMs',
  'prefetchHorizonTracks',
  'minLeadTimeMs',
  'maxConcurrentSegmentDownloads',
  'clockResyncIntervalMs',
  'driftDeadbandMs',
  'driftRescheduleThresholdMs',
  'engineOverride',
  'mediaElementSeekBiasMs',
  'moderationMode',
  'commentPendingExpiryMs',
  'commentsPerMinute',
  'pingsPerMinute',
  'strings',
] as const satisfies ReadonlyArray<keyof RuntimeConfig>;

const PERSISTED = new Set<string>(PERSISTED_KEYS);

const VenueFile = z.object({
  version: z.number().int(),
  venue: z.string().max(64),
  config: RuntimeConfigPatch,
  crates: z.array(Crate).max(200),
});

export interface VenueProfile {
  config: RuntimeConfigPatch;
  crates: Crate[];
}

/** Only the keys the venue owns, dropped from a wider patch. */
export function persistable(patch: RuntimeConfigPatch): RuntimeConfigPatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && PERSISTED.has(key)) out[key] = value;
  }
  return out as RuntimeConfigPatch;
}

export interface VenueStoreDeps {
  path: string;
  venue: string;
  logger: Logger;
  /** Writes are coalesced over this window; a slider drag is one write, not fifty. */
  debounceMs?: number;
}

export class VenueStore {
  #config: RuntimeConfigPatch = {};
  #crates: Crate[] = [];
  #timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: VenueStoreDeps) {}

  get config(): RuntimeConfigPatch {
    return { ...this.#config };
  }

  get crates(): Crate[] {
    return this.#crates.map((c) => ({ ...c, trackIds: [...c.trackIds] }));
  }

  /**
   * Read the profile from disk.
   *
   * A missing file is the normal first run. A corrupt or unparseable one is
   * logged and ignored rather than fatal: refusing to boot half an hour before
   * doors because a JSON file lost a brace would be the wrong trade, and every
   * value in here has a sane default.
   */
  load(): VenueProfile {
    let raw: string;
    try {
      raw = readFileSync(this.deps.path, 'utf8');
    } catch {
      this.deps.logger.event('info', 'venue.new', { venue: this.deps.venue });
      return { config: {}, crates: [] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.deps.logger.event('warn', 'venue.unreadable', { path: this.deps.path });
      return { config: {}, crates: [] };
    }

    const result = VenueFile.safeParse(parsed);
    if (!result.success) {
      this.deps.logger.event('warn', 'venue.invalid', {
        path: this.deps.path,
        detail: result.error.issues[0]?.message ?? 'invalid',
      });
      return { config: {}, crates: [] };
    }

    this.#config = persistable(result.data.config);
    this.#crates = result.data.crates;
    this.deps.logger.event('info', 'venue.loaded', {
      venue: this.deps.venue,
      settings: Object.keys(this.#config).length,
      crates: this.#crates.length,
    });
    return { config: this.config, crates: this.crates };
  }

  /** Merge a config delta into the profile and schedule a write. */
  updateConfig(patch: RuntimeConfigPatch): void {
    const keep = persistable(patch);
    if (Object.keys(keep).length === 0) return;
    this.#config = { ...this.#config, ...keep };
    this.#schedule();
  }

  setCrates(crates: readonly Crate[]): void {
    this.#crates = crates.map((c) => ({ ...c, trackIds: [...c.trackIds] }));
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer) return;
    const wait = this.deps.debounceMs ?? 500;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, wait);
    // Never hold the process open for a pending settings write.
    this.#timer.unref?.();
  }

  /**
   * Write the profile now.
   *
   * Temp file then rename, which is atomic within a directory: a power cut
   * mid-write leaves the previous profile intact rather than a truncated one
   * that fails to parse at the next boot.
   */
  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    const body = JSON.stringify(
      { version: 1, venue: this.deps.venue, config: this.#config, crates: this.#crates },
      null,
      2,
    );

    try {
      mkdirSync(dirname(this.deps.path), { recursive: true });
      const temp = `${this.deps.path}.tmp`;
      writeFileSync(temp, `${body}\n`, { mode: 0o600 });
      renameSync(temp, this.deps.path);
    } catch (err) {
      // A profile that cannot be written is a problem for the next event, not
      // for this one. Log it and keep the set running.
      this.deps.logger.event('error', 'venue.write-failed', {
        path: this.deps.path,
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
}
