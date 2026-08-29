/**
 * The control connection.
 *
 * Owns the socket, the clock-sync loop and the reconnect policy. It deliberately
 * does *not* own playback: if the MacBook dies mid-set, phones with buffered
 * audio keep playing the schedule they already know, with a quiet reconnecting
 * indicator (D17). That converts the worst live failure into a minor one, and
 * it is nearly free — the scheduler already has everything it needs.
 *
 * This lives in `shared` rather than in the guest app because four things speak
 * this protocol: the guest PWA, the DJ dashboard, the `/display` route and the
 * virtual-client harness. It has no DOM dependency — the socket and the timers
 * are injected — so the harness drives it in Node unchanged, which is the whole
 * reason the harness is worth anything (Part E step 6).
 */

import { DEFAULT_RUNTIME_CONFIG, mergeConfig, type RuntimeConfig } from './constants.js';
import { parseServerMessage, type ServerMessage } from './protocol.js';
import { ClockSync } from './clocksync.js';

/** A socket, narrowed to what this needs, so tests can supply a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  /** The handler receives the WebSocket close code, which decides retry policy. */
  onClose(handler: (code: number) => void): void;
  onError(handler: () => void): void;
}

export interface ConnectionDeps {
  connect(): SocketLike;
  now(): number;
  /** Injected so reconnect backoff is testable without waiting. */
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onMessage(message: ServerMessage): void;
  onStatusChange?(status: ConnectionStatus): void;
}

export type ConnectionStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'closed'
  /** The session was refused. Retrying cannot fix it; the guest must join again. */
  | 'unauthorised';

/**
 * Application close code for a refused session, sent by the server at the
 * upgrade. Distinguished from every transport failure because it is the one
 * that a retry loop will never resolve — a session that expired, or a server
 * restarted with a new signing key, would otherwise leave a guest watching
 * "reconnecting" forever with no way out.
 */
export const CLOSE_UNAUTHORISED = 4401;

/**
 * Backoff, capped low on purpose. This is a LAN with one hop; a minute-long
 * backoff after a server restart would leave the room stale long after it came
 * back.
 */
const BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];

export class Connection {
  readonly clock: ClockSync;

  #socket: SocketLike | null = null;
  #status: ConnectionStatus = 'closed';
  #attempt = 0;
  #reconnectTimer: unknown = null;
  #resyncTimer: unknown = null;
  #closedByUs = false;
  #config: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG };
  #channelId: string | null = null;

  constructor(private readonly deps: ConnectionDeps) {
    this.clock = new ClockSync({
      send: (t0) => this.send({ t: 'ping', t0 }),
      now: deps.now,
    });
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  get config(): RuntimeConfig {
    return this.#config;
  }

  /** Estimated server time. Throws until the first sync round lands. */
  serverNow(): number {
    return this.clock.estimatedServerNow();
  }

  open(channelId: string): void {
    this.#channelId = channelId;
    this.#closedByUs = false;
    this.#openSocket();
  }

  close(): void {
    this.#closedByUs = true;
    this.deps.clearTimer(this.#reconnectTimer);
    this.deps.clearTimer(this.#resyncTimer);
    this.#socket?.close();
    this.#setStatus('closed');
  }

  send(message: unknown): void {
    // Dropped rather than queued while offline. Every message this client sends
    // is either a clock sample or a comment, and a stale one of either is worse
    // than none.
    if (this.#status !== 'live') return;
    this.#socket?.send(JSON.stringify(message));
  }

  /** Periodic re-sync, driven by the app's timer (D9). */
  resync(): void {
    if (this.#status === 'live') this.clock.beginRound();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #openSocket(): void {
    this.#setStatus(this.#attempt === 0 ? 'connecting' : 'reconnecting');
    const socket = this.deps.connect();
    this.#socket = socket;

    socket.onOpen(() => {
      this.#attempt = 0;
      this.#setStatus('live');
      // Clock first, then subscribe: a `state` that arrives before the offset
      // is locked cannot be scheduled against anything.
      this.clock.beginRound();
      if (this.#channelId) this.send({ t: 'subscribe', channelId: this.#channelId });
    });

    socket.onMessage((raw) => this.#handle(raw));
    socket.onClose((code) => this.#scheduleReconnect(code));
    socket.onError(() => this.#scheduleReconnect());
  }

  #handle(raw: string): void {
    const parsed = parseServerMessage(raw);
    // A frame the client cannot parse is dropped, not guessed at. The protocol
    // is validated on both ends from the same schemas (D12).
    if (!parsed.ok) return;

    const message = parsed.value;
    if (message.t === 'pong') {
      this.clock.handlePong(message.t0, message.t1);
      return;
    }
    // `hello` carries the whole config, `config` carries a delta; both merge
    // the same way.
    if (message.t === 'hello') {
      this.#config = mergeConfig(this.#config, message.config);
    } else if (message.t === 'config') {
      this.#config = mergeConfig(this.#config, message.patch);
    }
    this.deps.onMessage(message);
  }

  #scheduleReconnect(code?: number): void {
    this.#socket = null;
    if (this.#closedByUs) return;

    if (code === CLOSE_UNAUTHORISED) {
      // No amount of retrying fixes a refused session. Surface it so the guest
      // is sent back to the join screen rather than left watching a spinner.
      this.#setStatus('unauthorised');
      return;
    }

    this.#setStatus('reconnecting');
    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] as number;
    this.#attempt++;
    this.deps.clearTimer(this.#reconnectTimer);
    this.#reconnectTimer = this.deps.setTimer(() => this.#openSocket(), delay);
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.deps.onStatusChange?.(status);
  }
}
