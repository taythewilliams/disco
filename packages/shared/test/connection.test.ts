import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/protocol.js';
import {
  CLOSE_UNAUTHORISED,
  Connection,
  type ConnectionStatus,
  type SocketLike,
} from '../src/connection.js';

/** A socket a test opens, feeds and drops by hand. */
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  #open: (() => void) | null = null;
  #message: ((data: string) => void) | null = null;
  #close: ((code: number) => void) | null = null;
  #error: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  onOpen(handler: () => void): void {
    this.#open = handler;
  }
  onMessage(handler: (data: string) => void): void {
    this.#message = handler;
  }
  onClose(handler: (code: number) => void): void {
    this.#close = handler;
  }
  onError(handler: () => void): void {
    this.#error = handler;
  }

  fireOpen(): void {
    this.#open?.();
  }
  deliver(message: unknown): void {
    this.#message?.(JSON.stringify(message));
  }
  deliverRaw(raw: string): void {
    this.#message?.(raw);
  }
  drop(code = 1006): void {
    this.#close?.(code);
  }
  fail(): void {
    this.#error?.();
  }
  parsed(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

let sockets: FakeSocket[];
let timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
let received: ServerMessage[];
let statuses: ConnectionStatus[];
let clock: number;
let connection: Connection;

const runTimers = () => {
  const due = timers.filter((t) => !t.cancelled);
  timers = [];
  for (const t of due) t.fn();
};

beforeEach(() => {
  sockets = [];
  timers = [];
  received = [];
  statuses = [];
  clock = 1_000;
  connection = new Connection({
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => clock++,
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cancelled: false };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      if (handle) (handle as { cancelled: boolean }).cancelled = true;
    },
    onMessage: (message) => received.push(message),
    onStatusChange: (status) => statuses.push(status),
  });
});

const hello = (): ServerMessage => ({
  t: 'hello',
  protocolVersion: 1,
  clientId: 'abcd',
  role: 'guest',
  serverTime: 500_000,
  channels: ['*'],
  config: { prefetchHorizonTracks: 4 },
});

describe('opening', () => {
  it('syncs the clock before subscribing', () => {
    // A `state` arriving before the offset is locked cannot be scheduled
    // against anything, so the ping round goes first (D9).
    connection.open('main');
    sockets[0]?.fireOpen();

    const sent = sockets[0]?.parsed() ?? [];
    const firstSubscribe = sent.findIndex((m) => (m as { t: string }).t === 'subscribe');
    const pings = sent.filter((m) => (m as { t: string }).t === 'ping');
    expect(pings.length).toBeGreaterThan(0);
    expect(firstSubscribe).toBe(sent.length - 1);
  });

  it('reports status transitions', () => {
    connection.open('main');
    sockets[0]?.fireOpen();
    expect(statuses).toEqual(['connecting', 'live']);
  });

  it('applies the config that arrives with hello', () => {
    connection.open('main');
    sockets[0]?.fireOpen();
    sockets[0]?.deliver(hello());
    expect(connection.config.prefetchHorizonTracks).toBe(4);
    // Untouched keys keep their defaults rather than becoming undefined.
    expect(connection.config.moderationMode).toBe('review');
  });

  it('merges a later config delta without blanking anything', () => {
    connection.open('main');
    sockets[0]?.fireOpen();
    sockets[0]?.deliver(hello());
    sockets[0]?.deliver({ t: 'config', patch: { feedHidden: true } });
    expect(connection.config.feedHidden).toBe(true);
    expect(connection.config.prefetchHorizonTracks).toBe(4);
  });
});

describe('messages', () => {
  beforeEach(() => {
    connection.open('main');
    sockets[0]?.fireOpen();
  });

  it('handles pongs itself rather than passing them up', () => {
    const ping = (sockets[0]?.parsed() ?? []).find((m) => (m as { t: string }).t === 'ping') as {
      t0: number;
    };
    sockets[0]?.deliver({ t: 'pong', t0: ping.t0, t1: 500_000 });
    expect(received.some((m) => m.t === 'pong')).toBe(false);
  });

  it('passes everything else up', () => {
    sockets[0]?.deliver(hello());
    expect(received.map((m) => m.t)).toEqual(['hello']);
  });

  it('drops a frame it cannot parse rather than guessing', () => {
    // Both ends validate against the same schemas; an unparseable frame is a
    // bug or an attack, and neither is worth improvising over (D12).
    sockets[0]?.deliverRaw('{not json');
    sockets[0]?.deliver({ t: 'nonsense' });
    expect(received).toHaveLength(0);
  });
});

describe('resilience', () => {
  it('reconnects with backoff after a drop', () => {
    connection.open('main');
    sockets[0]?.fireOpen();
    sockets[0]?.drop();

    expect(connection.status).toBe('reconnecting');
    expect(timers[0]?.ms).toBe(250);
    runTimers();
    expect(sockets).toHaveLength(2);
  });

  it('lengthens the backoff across repeated failures but caps it low', () => {
    // A LAN with one hop. A minute-long backoff after a server restart would
    // leave the room stale long after it came back.
    connection.open('main');
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      // Never fires open: the server is down, not flapping.
      sockets.at(-1)?.drop();
      delays.push(timers.at(-1)?.ms ?? 0);
      runTimers();
    }
    expect(delays.slice(0, 3)).toEqual([250, 500, 1_000]);
    expect(Math.max(...delays)).toBe(8_000);
  });

  it('resets the backoff once a connection succeeds', () => {
    // A server that restarts twice should not be met with an ever-growing wait.
    connection.open('main');
    sockets[0]?.drop();
    runTimers();
    sockets[1]?.drop();
    expect(timers.at(-1)?.ms).toBe(500);
    runTimers();

    sockets[2]?.fireOpen();
    sockets[2]?.drop();
    expect(timers.at(-1)?.ms).toBe(250);
  });

  it('treats an error like a drop', () => {
    connection.open('main');
    sockets[0]?.fireOpen();
    sockets[0]?.fail();
    expect(connection.status).toBe('reconnecting');
  });

  it('drops outbound messages while offline rather than queueing them', () => {
    // Everything this client sends is a clock sample or a comment. A stale one
    // of either is worse than none.
    connection.open('main');
    sockets[0]?.fireOpen();
    sockets[0]?.drop();
    connection.send({ t: 'comment', text: 'held back' });
    expect(sockets[0]?.sent.some((s) => s.includes('held back'))).toBe(false);
  });

  it('does not reconnect after a deliberate close', () => {
    connection.open('main');
    sockets[0]?.fireOpen();
    connection.close();
    sockets[0]?.drop();
    runTimers();
    expect(sockets).toHaveLength(1);
    expect(connection.status).toBe('closed');
  });

  it('stops retrying when the session is refused', () => {
    // A retry loop cannot fix an expired session or a server restarted with a
    // new signing key. Left retrying, the guest watches "reconnecting" forever
    // with no way back to the join screen.
    connection.open('main');
    sockets[0]?.fireOpen();
    sockets[0]?.drop(CLOSE_UNAUTHORISED);

    expect(connection.status).toBe('unauthorised');
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(0);
    runTimers();
    expect(sockets).toHaveLength(1);
  });

  it('still retries every other close code', () => {
    connection.open('main');
    sockets[0]?.fireOpen();
    sockets[0]?.drop(1006);
    expect(connection.status).toBe('reconnecting');
    runTimers();
    expect(sockets).toHaveLength(2);
  });

  it('re-subscribes on reconnect', () => {
    // The reconnect is a fresh connection: the server knows nothing about this
    // client, so the channel subscription has to be re-sent.
    connection.open('main');
    sockets[0]?.fireOpen();
    sockets[0]?.drop();
    runTimers();
    sockets[1]?.fireOpen();
    expect(
      (sockets[1]?.parsed() ?? []).some((m) => (m as { t: string }).t === 'subscribe'),
    ).toBe(true);
  });
});
