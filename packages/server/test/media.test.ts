import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { MediaPathError, isAllowedTrackFile, isInside, resolveTrackFile } from '../src/media.js';

const ROOT = '/srv/disco/media';
const TRACK = 'a3a23b67f9c757b182311d64c08a5d62';

describe('resolveTrackFile', () => {
  it('resolves a segment inside the media root', () => {
    expect(resolveTrackFile(ROOT, TRACK, 'seg-00007.m4s')).toBe(
      resolve(ROOT, 'tracks', TRACK, 'seg-00007.m4s'),
    );
  });

  it('resolves the other files a track directory holds', () => {
    for (const file of ['init.mp4', 'peaks.json', 'beats.json', 'art-256.jpg', 'art-1024.jpg']) {
      expect(() => resolveTrackFile(ROOT, TRACK, file)).not.toThrow();
    }
  });

  it('refuses traversal in the track ID', () => {
    // Never reachable through the protocol — `SafeId` rejects these first — but
    // this is the gate that still holds if a future caller skips the schema.
    for (const id of ['..', '../..', '../../etc', 'a/b', 'a\\b', '.', '%2e%2e', 'a.b']) {
      expect(() => resolveTrackFile(ROOT, id, 'init.mp4')).toThrow(MediaPathError);
    }
  });

  it('refuses traversal in the filename', () => {
    for (const file of [
      '../../../etc/passwd',
      '../init.mp4',
      'seg-00000.m4s/../../../x',
      '.env',
      'disco.db',
      'seg-0.m4s',
      'seg-00000.m4s.bak',
    ]) {
      expect(() => resolveTrackFile(ROOT, TRACK, file)).toThrow(MediaPathError);
    }
  });

  it('refuses an absolute path as a filename', () => {
    expect(() => resolveTrackFile(ROOT, TRACK, '/etc/passwd')).toThrow(MediaPathError);
  });

  it('refuses the manifest itself', () => {
    // `media/disco.db` sits beside the track directories and holds the whole
    // library. It is not a track file and must never be served.
    expect(() => resolveTrackFile(ROOT, TRACK, 'disco.db')).toThrow(MediaPathError);
  });
});

describe('isAllowedTrackFile', () => {
  it('accepts exactly the files ingest writes', () => {
    expect(isAllowedTrackFile('seg-00000.m4s')).toBe(true);
    expect(isAllowedTrackFile('seg-99999.m4s')).toBe(true);
    expect(isAllowedTrackFile('init.mp4')).toBe(true);
  });

  it('rejects the playlist and anything else in the directory', () => {
    // `index.m3u8` is a build artefact of the segmenter, not something the
    // client asks for.
    expect(isAllowedTrackFile('index.m3u8')).toBe(false);
    expect(isAllowedTrackFile('analysis.wav')).toBe(false);
    expect(isAllowedTrackFile('')).toBe(false);
  });
});

describe('isInside', () => {
  it('accepts the root and its descendants', () => {
    expect(isInside(ROOT, ROOT)).toBe(true);
    expect(isInside(ROOT, `${ROOT}/tracks/x/init.mp4`)).toBe(true);
  });

  it('rejects siblings that merely share a prefix', () => {
    // The classic off-by-one in this check: `/srv/disco/media-backup` starts
    // with `/srv/disco/media`.
    expect(isInside(ROOT, '/srv/disco/media-backup/secret')).toBe(false);
    expect(isInside(ROOT, '/srv/disco')).toBe(false);
    expect(isInside(ROOT, '/etc/passwd')).toBe(false);
  });

  it('normalises before comparing', () => {
    expect(isInside(ROOT, `${ROOT}/tracks/../../etc`)).toBe(false);
    expect(isInside(ROOT, `${ROOT}/tracks/../tracks/x`)).toBe(true);
  });
});
