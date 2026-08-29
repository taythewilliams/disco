/**
 * The projector (D8).
 *
 * A WebSocket client of the same feed the phones read — not a view onto
 * in-process server state. That is what makes moving it to a second machine a
 * config change rather than a rewrite, and what makes a future Art-Net/DMX
 * bridge the same component with a different renderer.
 *
 * It is read-only by construction: the `display` role may send nothing that
 * changes anything (protocol `ALLOWED_ROLES`). A screen in a public room should
 * not be able to skip a track.
 *
 * Everything a guest wrote is rendered as React children — never `innerHTML`.
 * This is the surface that makes comment text a live XSS target, and it is the
 * most likely injection vector in the system (D7, OWASP A03).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  beatPhaseAt,
  channelColours,
  channelHue,
  parseBeatGrid,
  projectorPositionMs,
  type BeatGrid,
  type FeedItem,
} from '@disco/shared';
import { useDisco } from '../useDisco.js';
import { qrPath, joinUrl } from './qr.js';
import { FrameRate, frameFor, render } from './visuals.js';

/** Comments visible at once. More than this is unreadable across a room. */
const FEED_LIMIT = 6;

export function Display({ debug = false }: { debug?: boolean }) {
  const disco = useDisco(true);
  const channelId = disco.state?.channelId ?? 'main';
  const colours = useMemo(() => channelColours(channelId), [channelId]);
  const track = disco.state?.trackId ? disco.tracks.get(disco.state.trackId) : undefined;
  const [fps, setFps] = useState(0);

  const grid = useBeatGrid(track?.beatsUrl ?? null, track?.bpm ?? null);

  const playing = Boolean(disco.state?.trackId) && disco.state?.paused === false;

  useVisualiser({
    hue: channelHue(channelId),
    idle: !playing,
    grid,
    startAtServerTime: disco.state?.startAtServerTime ?? null,
    projectorOffsetMs: disco.config.projectorOffsetMs,
    serverNow: disco.serverNow,
    onFps: debug ? setFps : undefined,
  });

  return (
    <div className="display" style={{ ['--channel' as string]: colours.accent }}>
      <canvas className="display-canvas" id="display-canvas" />

      <div className="display-content">
        <header className="display-now">
          {track ? (
            <>
              <span className="display-channel">{channelId}</span>
              <h1>{track.title}</h1>
              <p>{track.artist}</p>
            </>
          ) : (
            <>
              <span className="display-channel">{channelId}</span>
              <h1>Disco</h1>
              <p>Scan to join</p>
            </>
          )}
        </header>

        {/* Quiet moments only: a QR competing with a track nobody has joined
            for is just clutter (D8). */}
        {!playing && <JoinCode />}

        <Feed items={disco.feed} hidden={disco.feedHidden} />
      </div>

      {/* The load test needs a number, not an impression: is one MacBook enough
          for the server, thirty phones and a full-screen visualiser? */}
      {debug && (
        <p className="display-debug">
          {fps.toFixed(0)} fps · {disco.status} · rtt {disco.clock.rttMs.toFixed(1)} ms · offset{' '}
          {disco.config.projectorOffsetMs} ms
        </p>
      )}
    </div>
  );
}

function Feed({ items, hidden }: { items: FeedItem[]; hidden: boolean }) {
  // The panic control removes the feed and leaves visuals and now-playing
  // intact. That is the whole point of it being a separate element (D7).
  if (hidden || items.length === 0) return null;
  return (
    <ul className="display-feed">
      {items.slice(-FEED_LIMIT).map((item) => (
        // React escapes this. It is the only place guest text reaches a wall in
        // front of a room, and it is never `innerHTML`.
        <li key={item.id}>{item.text}</li>
      ))}
    </ul>
  );
}

function JoinCode() {
  const url = joinUrl(window.location);
  const qr = useMemo(() => qrPath(url), [url]);
  return (
    <div className="display-join">
      <svg viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={`Join at ${url}`}>
        <rect width={qr.size} height={qr.size} fill="#fff" />
        <path d={qr.d} fill="#000" />
      </svg>
      <p>{url.replace(/^https?:\/\//, '')}</p>
    </div>
  );
}

/**
 * Load the beat grid for the playing track.
 *
 * Fetched from the same immutable media URL the phones use, so it is cached
 * after the first play. A track whose detection failed, or whose grid fails to
 * load, falls back to its BPM — and if there is no BPM either, the visualiser
 * rests rather than inventing a tempo.
 */
function useBeatGrid(beatsUrl: string | null, bpm: number | null): BeatGrid | null {
  const [grid, setGrid] = useState<BeatGrid | null>(null);

  useEffect(() => {
    if (!beatsUrl) {
      setGrid(bpm ? synthesise(bpm) : null);
      return;
    }
    let cancelled = false;
    void fetch(beatsUrl, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((raw) => {
        if (cancelled) return;
        const parsed = raw ? parseBeatGrid(raw) : null;
        setGrid(parsed?.beatsMs.length ? parsed : bpm ? synthesise(bpm) : null);
      })
      .catch(() => {
        if (!cancelled) setGrid(bpm ? synthesise(bpm) : null);
      });
    return () => {
      cancelled = true;
    };
  }, [beatsUrl, bpm]);

  return grid;
}

/** A grid from a tempo alone: even spacing, good enough to keep time by eye. */
function synthesise(bpm: number): BeatGrid {
  const interval = 60_000 / bpm;
  const beats: number[] = [];
  for (let ms = 0; ms < 12 * 60_000; ms += interval) beats.push(ms);
  return { bpm, beatsMs: beats };
}

interface VisualiserOptions {
  hue: number;
  idle: boolean;
  grid: BeatGrid | null;
  startAtServerTime: number | null;
  projectorOffsetMs: number;
  serverNow: () => number | null;
  onFps?: ((fps: number) => void) | undefined;
}

/**
 * The animation loop.
 *
 * Kept out of React's render path entirely: sixty state updates a second would
 * be sixty reconciliations a second, on the machine that is also running the
 * server. The canvas is addressed by id and drawn to directly.
 */
function useVisualiser(options: VisualiserOptions): void {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const canvas = document.getElementById('display-canvas') as HTMLCanvasElement | null;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const rate = new FrameRate();
    let handle = 0;
    let lastFpsReport = 0;

    const resize = () => {
      // Cap at 2× so a HiDPI laptop driving a projector is not quietly
      // rendering four times the pixels the projector can show.
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * scale);
      canvas.height = Math.floor(window.innerHeight * scale);
    };
    resize();
    window.addEventListener('resize', resize);

    /**
     * Cost of one frame, in milliseconds, averaged over `frames` draws.
     *
     * The load test's real question is whether the visualiser starves the
     * server, and frame *rate* cannot answer it: a browser that is throttling
     * a backgrounded window reports a low rate while costing nothing. Frame
     * *cost* answers it directly — 60 Hz of a 0.3 ms frame is 2 % of a core —
     * and it is measurable without a projector attached (D8).
     *
     * Debug only, and it runs the same `frameFor`/`render` the projector runs.
     */
    if (latest.current.onFps) {
      (globalThis as { __discoFrameCostMs?: (frames: number) => number }).__discoFrameCostMs = (
        frames = 200,
      ) => {
        const o = latest.current;
        const startedAt = performance.now();
        for (let i = 0; i < frames; i++) {
          const positionMs = i * 16.7;
          const phase = o.grid ? beatPhaseAt(o.grid, positionMs) : null;
          render(ctx, frameFor({ phase, positionMs, width: canvas.width, height: canvas.height }), {
            hue: o.hue,
            idle: false,
          });
        }
        return (performance.now() - startedAt) / frames;
      };
    }

    const draw = (frameTime: number) => {
      handle = requestAnimationFrame(draw);
      const o = latest.current;

      const serverNow = o.serverNow();
      // Before the clock locks there is no shared timeline to draw against, so
      // the field rests rather than guessing at a position.
      const positionMs =
        serverNow !== null && o.startAtServerTime !== null
          ? projectorPositionMs(serverNow, o.startAtServerTime, o.projectorOffsetMs)
          : 0;

      const phase = o.grid && !o.idle ? beatPhaseAt(o.grid, positionMs) : null;
      render(ctx, frameFor({ phase, positionMs, width: canvas.width, height: canvas.height }), {
        hue: o.hue,
        idle: o.idle,
      });

      const fps = rate.sample(frameTime);
      if (o.onFps && frameTime - lastFpsReport > 500) {
        lastFpsReport = frameTime;
        o.onFps(fps);
      }
    };
    handle = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(handle);
      window.removeEventListener('resize', resize);
    };
  }, []);
}
