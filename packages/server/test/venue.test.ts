import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger, type LogLevel } from '../src/log.js';
import { VenueStore, persistable } from '../src/venue.js';

let dir: string;
let path: string;

const store = (over: { debounceMs?: number } = {}) =>
  new VenueStore({ path, venue: 'test-venue', logger: silentLogger, debounceMs: 0, ...over });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'disco-venue-'));
  path = join(dir, 'venue-test.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('persistable', () => {
  it('keeps what belongs to the venue', () => {
    expect(persistable({ projectorOffsetMs: 45, moderationMode: 'open' })).toEqual({
      projectorOffsetMs: 45,
      moderationMode: 'open',
    });
  });

  it('drops the panic control', () => {
    // A server that came back up with the feed still hidden, and nobody
    // remembering why, is a mystery at exactly the wrong moment (D7).
    expect(persistable({ feedHidden: true, projectorOffsetMs: 10 })).toEqual({
      projectorOffsetMs: 10,
    });
  });
});

describe('VenueStore', () => {
  it('starts empty when there is no profile yet', () => {
    expect(store().load()).toEqual({ config: {}, crates: [] });
  });

  it('round-trips the projector offset through a restart', async () => {
    // The reason this file exists: nobody should measure the projector offset
    // twice because the server was restarted at 9pm (D8).
    const first = store();
    first.load();
    first.updateConfig({ projectorOffsetMs: 65, feedHidden: true });
    first.flush();

    const reopened = store().load();
    expect(reopened.config).toEqual({ projectorOffsetMs: 65 });
  });

  it('round-trips crates', () => {
    const first = store();
    first.load();
    first.setCrates([{ name: 'Warm up', trackIds: ['aaa', 'bbb'] }]);
    first.flush();

    expect(store().load().crates).toEqual([{ name: 'Warm up', trackIds: ['aaa', 'bbb'] }]);
  });

  it('merges successive changes rather than replacing them', () => {
    const s = store();
    s.load();
    s.updateConfig({ projectorOffsetMs: 20 });
    s.updateConfig({ moderationMode: 'open' });
    s.flush();
    expect(store().load().config).toEqual({ projectorOffsetMs: 20, moderationMode: 'open' });
  });

  it('ignores a profile that will not parse rather than refusing to boot', async () => {
    // Half an hour before doors is not the time to fail on a missing brace.
    await writeFile(path, '{ not json');
    const levels: LogLevel[] = [];
    const noisy = new VenueStore({
      path,
      venue: 'test-venue',
      logger: { event: (level) => levels.push(level) },
    });
    expect(noisy.load()).toEqual({ config: {}, crates: [] });
    expect(levels).toContain('warn');
  });

  it('ignores a profile with values outside the schema', async () => {
    await writeFile(
      path,
      JSON.stringify({ version: 1, venue: 'x', config: { projectorOffsetMs: 9_999 }, crates: [] }),
    );
    expect(store().load().config).toEqual({});
  });

  it('writes atomically and leaves no temp file behind', async () => {
    const s = store();
    s.load();
    s.updateConfig({ prefetchHorizonTracks: 3 });
    s.flush();

    const written = JSON.parse(await readFile(path, 'utf8')) as { venue: string };
    expect(written.venue).toBe('test-venue');
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toThrow();
  });

  it('survives a directory it cannot write to', () => {
    // A profile that cannot be saved is a problem for the next event, not this
    // one. The set keeps running.
    const broken = new VenueStore({
      path: join(dir, 'venue-test.json', 'nested', 'venue.json'),
      venue: 'test-venue',
      logger: silentLogger,
      debounceMs: 0,
    });
    broken.load();
    expect(() => {
      broken.updateConfig({ projectorOffsetMs: 5 });
      broken.flush();
    }).not.toThrow();
  });
});
