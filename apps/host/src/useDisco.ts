/**
 * The dashboard's live connection.
 *
 * Wraps the shared `Connection` in React state. The browser socket is adapted to
 * `SocketLike` here, which is the only browser-specific line in the whole
 * control path — the same `Connection` runs unchanged in the virtual-client
 * harness under Node.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Connection,
  DEFAULT_CHANNEL_ID,
  DEFAULT_RUNTIME_CONFIG,
  type ConnectionStatus,
  type Crate,
  type FeedItem,
  type RuntimeConfig,
  type RuntimeConfigPatch,
  type ServerMessage,
  type SocketLike,
  type StateMsg,
  type TrackMetaMsg,
} from '@disco/shared';

function browserSocket(url: string): SocketLike {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onOpen: (h) => socket.addEventListener('open', () => h()),
    onMessage: (h) => socket.addEventListener('message', (e) => h(String(e.data))),
    onClose: (h) => socket.addEventListener('close', (e) => h(e.code)),
    onError: (h) => socket.addEventListener('error', () => h()),
  };
}

export interface DiscoState {
  status: ConnectionStatus;
  state: StateMsg | null;
  tracks: Map<string, TrackMetaMsg>;
  feed: FeedItem[];
  pending: FeedItem[];
  feedHidden: boolean;
  /** Saved crates, sent to the dashboard only (D10). */
  crates: Crate[];
  config: RuntimeConfig;
  clock: { locked: boolean; offsetMs: number; rttMs: number };
  lastError: string | null;
}

export function useDisco(enabled: boolean) {
  const ref = useRef<Connection | null>(null);
  const [snapshot, setSnapshot] = useState<DiscoState>({
    status: 'closed',
    state: null,
    tracks: new Map(),
    feed: [],
    pending: [],
    feedHidden: false,
    crates: [],
    config: { ...DEFAULT_RUNTIME_CONFIG },
    clock: { locked: false, offsetMs: 0, rttMs: 0 },
    lastError: null,
  });

  useEffect(() => {
    if (!enabled) return;

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const connection = new Connection({
      connect: () => browserSocket(wsUrl),
      now: () => performance.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onStatusChange: (status) => setSnapshot((s) => ({ ...s, status })),
      onMessage: (message: ServerMessage) =>
        setSnapshot((s) => {
          switch (message.t) {
            case 'state':
              return { ...s, state: message };
            case 'trackMeta': {
              const tracks = new Map(s.tracks);
              tracks.set(message.trackId, message);
              return { ...s, tracks };
            }
            case 'feed':
              return {
                ...s,
                feed: message.items,
                pending: message.pending,
                feedHidden: message.hidden,
              };
            case 'crates':
              return { ...s, crates: message.items };
            case 'hello':
              return { ...s, config: connection.config };
            case 'config':
              return { ...s, config: connection.config };
            case 'error':
              return { ...s, lastError: message.message };
            default:
              return s;
          }
        }),
    });

    ref.current = connection;
    connection.open(DEFAULT_CHANNEL_ID);

    // Re-sync on the configured interval, and refresh the clock readout for the
    // status bar. When something goes wrong at 11pm, knowing instantly whether
    // it is one phone or all of them starts here (D11).
    const resync = setInterval(() => {
      connection.resync();
      setSnapshot((s) => ({
        ...s,
        clock: {
          locked: connection.clock.locked,
          offsetMs: connection.clock.locked ? connection.clock.offsetMs : 0,
          rttMs: connection.clock.rttMs,
        },
      }));
    }, DEFAULT_RUNTIME_CONFIG.clockResyncIntervalMs);

    return () => {
      clearInterval(resync);
      connection.close();
      ref.current = null;
    };
  }, [enabled]);

  const send = useCallback((message: unknown) => ref.current?.send(message), []);

  /** Estimated server time, or null before the first sync round lands. */
  const serverNow = useCallback(() => {
    const connection = ref.current;
    if (!connection || !connection.clock.locked) return null;
    return connection.serverNow();
  }, []);

  return { ...snapshot, send, serverNow };
}

export type ConfigPatch = RuntimeConfigPatch;
