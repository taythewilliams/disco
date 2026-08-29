/**
 * The guest runtime.
 *
 * Wires the shared `Connection`, the `SegmentCache`, an engine and the
 * `Scheduler` into React state. The interesting decisions all live in the
 * modules underneath; this is the assembly, plus the one browser-specific line
 * that adapts a `WebSocket` to `SocketLike`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Connection,
  DEFAULT_CHANNEL_ID,
  DEFAULT_RUNTIME_CONFIG,
  readinessOf,
  segmentIndexAt,
  segmentKey,
  type ConnectionStatus,
  type EngineOverride,
  type RuntimeConfig,
  type ServerMessage,
  type SocketLike,
  type StateMsg,
  type TrackMetaMsg,
  type TrackReadiness,
} from '@disco/shared';
import { DownloadRate, estimateCatchUpSec } from './arrival.js';
import { SegmentCache } from './cache.js';
import { selectEngine, detectCapabilities } from './engine/select.js';
import { MediaElementEngine } from './engine/mediaelement.js';
import { WebAudioEngine } from './engine/webaudio.js';
import type { EngineClock, PlaybackEngine } from './engine/types.js';
import { Scheduler } from './scheduler.js';

function browserSocket(url: string): SocketLike {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.readyState === WebSocket.OPEN && socket.send(data),
    close: () => socket.close(),
    onOpen: (h) => socket.addEventListener('open', () => h()),
    onMessage: (h) => socket.addEventListener('message', (e) => h(String(e.data))),
    onClose: (h) => socket.addEventListener('close', (e) => h(e.code)),
    onError: (h) => socket.addEventListener('error', () => h()),
  };
}

export interface GuestRuntime {
  status: ConnectionStatus;
  state: StateMsg | null;
  tracks: Map<string, TrackMetaMsg>;
  config: RuntimeConfig;
  clockLocked: boolean;
  audioReady: boolean;
  catchUpSec: number | null;
  driftMs: number;
  lastError: string | null;
  engineName: 'webaudio' | 'mediaelement' | null;
  /** The device ran out of room for audio. Shown to the guest, who can act on it. */
  storageFull: boolean;
  /** The AudioContext, shared with the calibration loop so both use one device. */
  context: AudioContext | null;
  setVolume(volume: number): void;
  setCalibrationMs(ms: number): void;
  sendComment(text: string): void;
  resume(): Promise<void>;
}

const TICK_MS = 250;

/**
 * Create the engine the capability check and the server-driven override
 * between them select (D2, D11).
 *
 * The media element is appended to the document rather than kept detached:
 * iOS will not give lock-screen controls or Media Session metadata to an
 * element that is not in the tree, and those are the whole reason this engine
 * exists (D16).
 */
function buildEngine(
  name: 'webaudio' | 'mediaelement',
  context: AudioContext,
  cache: SegmentCache,
  clock: EngineClock,
): { engine: PlaybackEngine; cleanup: () => void } {
  if (name === 'webaudio') {
    return { engine: new WebAudioEngine(context, cache, clock), cleanup: () => {} };
  }

  const element = document.createElement('audio');
  element.setAttribute('playsinline', '');
  element.preload = 'auto';
  element.style.display = 'none';
  document.body.appendChild(element);

  return {
    engine: new MediaElementEngine(element, cache, clock),
    cleanup: () => element.remove(),
  };
}

export function useGuest(active: boolean): GuestRuntime {
  const connectionRef = useRef<Connection | null>(null);
  const schedulerRef = useRef<Scheduler | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const cacheRef = useRef<SegmentCache | null>(null);
  const rateRef = useRef(new DownloadRate());
  const calibrationRef = useRef(0);
  /**
   * Track metadata, mirrored outside React state.
   *
   * The 250 ms tick needs current metadata, and reading it from state would
   * either capture a stale closure or force the whole runtime to be torn down
   * and rebuilt on every `trackMeta` message.
   */
  const tracksRef = useRef(new Map<string, TrackMetaMsg>());

  /**
   * The server-driven engine override (D2, D11).
   *
   * Held in state rather than read inline because changing it has to rebuild
   * the engine, and rebuilding the engine means tearing this effect down. The
   * cost is a brief re-buffer for the room — which is the honest price of the
   * DJ deliberately forcing an engine mid-event, and far cheaper than shipping
   * a fix.
   */
  const [engineOverride, setEngineOverride] = useState<EngineOverride>('auto');

  const [snapshot, setSnapshot] = useState({
    status: 'closed' as ConnectionStatus,
    state: null as StateMsg | null,
    tracks: new Map<string, TrackMetaMsg>(),
    config: { ...DEFAULT_RUNTIME_CONFIG },
    clockLocked: false,
    audioReady: false,
    catchUpSec: null as number | null,
    driftMs: 0,
    lastError: null as string | null,
    engineName: null as 'webaudio' | 'mediaelement' | null,
    storageFull: false,
  });

  useEffect(() => {
    if (!active) return;

    const context = new AudioContext();
    contextRef.current = context;

    // Injected everywhere rather than reached for, so the scheduler, the engine
    // and the calibration loop all share one definition of server time.
    const clock: EngineClock = {
      now: () => performance.now(),
      // Calibration shifts emission earlier by the guest's output latency, so
      // that audio arrives at the ear on the room's timeline (v4 Part 0).
      serverNow: () => (connectionRef.current?.clock.locked
        ? connectionRef.current.serverNow() + calibrationRef.current
        : 0),
      toClientTime: (serverTimeMs) =>
        connectionRef.current?.clock.locked
          ? connectionRef.current.clock.toClientTime(serverTimeMs - calibrationRef.current)
          : performance.now(),
    };

    const cache = new SegmentCache({
      fetchBytes: async (url) => {
        const startedAt = performance.now();
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(String(response.status));
        const bytes = await response.arrayBuffer();
        rateRef.current.record(bytes.byteLength, performance.now() - startedAt);
        return bytes;
      },
      decode: (bytes) => context.decodeAudioData(bytes),
      onStorageFull: () => setSnapshot((s) => ({ ...s, storageFull: true })),
    });
    cacheRef.current = cache;

    // Capability detection, then the override. `engineOverride` arrives in
    // `hello`, so the very first engine is the auto-detected one and a forced
    // engine takes effect on the rebuild below.
    const chosen = selectEngine(detectCapabilities(), engineOverride) ?? 'webaudio';
    const built = buildEngine(chosen, context, cache, clock);
    const engine = built.engine;
    engineRef.current = engine;

    const scheduler = new Scheduler({
      engine,
      cache,
      serverNow: () => clock.serverNow(),
      config: () => connectionRef.current?.config ?? DEFAULT_RUNTIME_CONFIG,
    });
    schedulerRef.current = scheduler;

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const connection = new Connection({
      connect: () => browserSocket(wsUrl),
      now: () => performance.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onStatusChange: (status) => setSnapshot((s) => ({ ...s, status })),
      onMessage: (message: ServerMessage) => {
        if (message.t === 'state') scheduler.applyState(message);
        if (message.t === 'trackMeta') {
          scheduler.learnTrack(message);
          tracksRef.current = new Map(tracksRef.current).set(message.trackId, message);
        }
        setSnapshot((s) => {
          switch (message.t) {
            case 'state':
              return { ...s, state: message, config: connection.config };
            case 'trackMeta':
              return { ...s, tracks: tracksRef.current };
            case 'hello':
            case 'config':
              setEngineOverride(connection.config.engineOverride);
              return { ...s, config: connection.config };
            case 'error':
              return { ...s, lastError: message.message };
            default:
              return s;
          }
        });
      },
    });
    connectionRef.current = connection;
    connection.open(DEFAULT_CHANNEL_ID);

    const tick = setInterval(() => {
      // Remote config, applied every pass so the DJ can correct it live (D11).
      if (engine instanceof MediaElementEngine) {
        engine.setSeekBiasMs(connection.config.mediaElementSeekBiasMs);
      }
      void scheduler.tick();

      const state = playbackState(scheduler);
      setSnapshot((s) => ({
        ...s,
        clockLocked: connection.clock.locked,
        audioReady: state.audioReady,
        catchUpSec: state.catchUpSec,
        driftMs: scheduler.lastDriftMs,
        engineName: chosen,
      }));

      // Telemetry: no PII, measurements only (D12). It is what turns "someone
      // says it sounds wrong" into a number on the dashboard.
      //
      // Two of these fields are not diagnostics. `ready` drives the readiness
      // bars the DJ holds a track against (D5), and `playing` is what the
      // server's segment admission control reads to put listeners ahead of
      // joiners — a rush at the door must not starve the floor (D4).
      if (connection.clock.locked) {
        connection.send({
          t: 'telemetry',
          offsetMs: connection.clock.offsetMs,
          rttMs: connection.clock.rttMs,
          driftMs: scheduler.lastDriftMs,
          calibrationMs: calibrationRef.current,
          engine: engine.name,
          bufferSec: state.bufferedSec,
          // Pause is a room-wide condition rather than a per-client one, so it
          // does not change how this client is ranked for downloads.
          playing: state.audioReady,
          ready: state.ready,
        });
      }
    }, TICK_MS);

    const resync = setInterval(
      () => connection.resync(),
      DEFAULT_RUNTIME_CONFIG.clockResyncIntervalMs,
    );

    /**
     * Readiness across the horizon, as the dashboard's "28/30 ready" bar
     * counts it (D5).
     *
     * Computed from segment membership with the same shared function the
     * dashboard's vocabulary comes from, so "ready" means one thing across the
     * system rather than one thing per surface.
     */
    function readinessReport(s: Scheduler): TrackReadiness[] {
      // The playing track plus the horizon, which is what this client is
      // fetching and what the dashboard's bars show.
      const plans = s.horizonPlans(connection.config.prefetchHorizonTracks + 1);
      return plans.map((plan) => {
        const held = new Set<string>();
        plan.segmentDurationsMs.forEach((_, index) => {
          if (cache.has(plan.trackId, index)) held.add(segmentKey(plan.trackId, index));
        });
        return { trackId: plan.trackId, state: readinessOf(plan, held) };
      });
    }

    function playbackState(s: Scheduler) {
      const trackId = s.currentTrackId;
      const meta = trackId ? tracksRef.current.get(trackId) : undefined;
      const ready = readinessReport(s);
      if (!trackId || !meta)
        return { audioReady: false, catchUpSec: null, bufferedSec: 0, ready };

      const held = meta.segments.filter((seg) => cache.has(trackId, seg.index));
      const bufferedSec = held.reduce((acc, seg) => acc + seg.durationMs, 0) / 1000;

      // Readiness is "do we hold the segment under the playhead", which is true
      // for both engines. Counting decoded buffers would report a media element
      // as never ready, because it is fed encoded bytes and decodes nothing.
      const positionMs = Math.max(0, clock.serverNow() - (s.currentStartAtServerTime ?? 0));
      const needed = segmentIndexAt(
        meta.segments.map((seg) => seg.durationMs),
        positionMs,
      );
      const audioReady = cache.has(trackId, needed) && cache.hasInit(trackId);

      // Only what is missing between here and the playhead counts towards the
      // catch-up estimate: segments beyond the buffer target are not something
      // the guest is waiting on.
      const missingBytes = meta.segments
        .filter((seg) => seg.index >= needed && !cache.has(trackId, seg.index))
        .reduce((acc, seg) => acc + seg.bytes, 0);

      return {
        audioReady,
        catchUpSec: audioReady ? 0 : estimateCatchUpSec(missingBytes, rateRef.current),
        bufferedSec,
        ready,
      };
    }

    return () => {
      clearInterval(tick);
      clearInterval(resync);
      connection.close();
      void engine.dispose();
      built.cleanup();
      connectionRef.current = null;
      schedulerRef.current = null;
      engineRef.current = null;
      contextRef.current = null;
      cacheRef.current = null;
    };
  }, [active, engineOverride]);

  const setVolume = useCallback((volume: number) => {
    engineRef.current?.setVolume(volume);
  }, []);

  const setCalibrationMs = useCallback((ms: number) => {
    calibrationRef.current = ms;
  }, []);

  const sendComment = useCallback((text: string) => {
    connectionRef.current?.send({ t: 'comment', text });
  }, []);

  /**
   * Resume the audio context.
   *
   * Every browser starts it suspended until a user gesture. The arrival flow
   * spends one on the join button, which is why calibration can begin
   * immediately afterwards with sound (D4).
   */
  const resume = useCallback(async () => {
    const context = contextRef.current;
    if (context && context.state === 'suspended') await context.resume().catch(() => {});
  }, []);

  return useMemo(
    () => ({
      ...snapshot,
      context: contextRef.current,
      setVolume,
      setCalibrationMs,
      sendComment,
      resume,
    }),
    [snapshot, setVolume, setCalibrationMs, sendComment, resume],
  );
}
