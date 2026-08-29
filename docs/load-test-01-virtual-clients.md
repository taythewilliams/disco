# Load test 01 — 30 virtual clients, loopback

First run of the virtual-client harness (BUILD.md Part E step 6), 2026-08-29.

**This is not the venue test.** Everything below ran over loopback on one
MacBook: no radio, no contention, no distance. It establishes that the server
and the protocol behave correctly at 30 clients and gives a baseline to compare
the real access-point run against in Phase 3. The bandwidth numbers are an upper
bound on what the software *asks for*, not a prediction of what the air will
deliver.

## Setup

- Server: `packages/server`, Node 24, SQLite manifest, `media/` on local disk.
- Library: three ingested test tracks, 62 s each, three ~25 s fMP4 segments per
  track, AAC-LC 192 kbps.
- Clients: `packages/server/test/harness`, 30 instances. Each opens its own
  session, its own WebSocket, syncs its own clock, and fetches segments through
  the same `planPrefetch` the guest PWA uses.
- DJ queued all three tracks and started the set before the clients arrived.

```bash
npm run harness -- --url http://127.0.0.1:3999 --clients 30 --stagger 0 --seconds 20
```

## Results

| | Rush (0 ms stagger) | Staggered (2 s apart) |
|---|---|---|
| Clients clock-locked | 30 / 30 | 30 / 30 |
| **Clock offset spread** | **0.7 ms** | **1.1 ms** |
| Offset standard deviation | 0.1 ms | 0.2 ms |
| RTT median / p95 | 0.3 / 0.9 ms | 0.7 / 1.0 ms |
| Time to ready median / max | 250 / 251 ms | 251 / 261 ms |
| Downloaded | 36.8 MB over 360 requests | 35.0 MB over 299 requests |
| Aggregate throughput | **14.7 Mbps** | **3.5 Mbps** |
| Failed requests | 0 | 0 |
| Protocol errors | none | none |

Time to ready is measured from the moment a client learns of a playable track,
not from process start — see the note below.

## What it says

**Clock sync is not the problem.** Sub-millisecond spread across 30 clients,
against the 2–5 ms the budget allows for it (v4 Part 0). This is the term the
architecture directly controls, and it has margin to spare. Calibration variance
remains the dominant term, and Spike 3 remains the highest-value spike.

**Nobody starves.** The gap between the first and last client reaching a
playable state was **2 ms** under a simultaneous rush. The concurrency cap plus
playhead-first ordering is doing what it was built to do; no client was left
behind while others filled their buffers.

**The stagger is worth roughly 4×.** Near-identical work — 36.8 MB against
35.0 MB — at 14.7 Mbps compressed into a rush versus 3.5 Mbps spread over a
minute. D4 assumes arrivals are naturally staggered, and this is what that
assumption is worth. If the venue admits people in a block, prefetch depth is
the lever and it is remote-configurable.

**Normal arrival traffic does not trip a rate limit.** Zero protocol errors
across 30 clients each firing a 16-ping lock-on round. Worth confirming: a ping
limit tight enough to refuse the initial round would delay every guest at the
door and would look like a network fault.

## What this run does not tell you

- **Anything about radio.** 14.7 Mbps over loopback says nothing about the same
  load over 5 GHz with 30 associated clients at varying distance. That is the
  Phase 3 load test against the real access point, and it is the number that
  decides whether prefetch depth needs tuning.
- **Anything about audio.** The harness does not decode. Scheduling precision,
  drift correction and calibration are Spikes 2, 3 and 5.
- **Anything about a large library.** Three tracks. Library size affects the
  dashboard, not the client (D10), and the dashboard list has not been exercised
  at 2 000 rows.

## Three things the run found

1. **`trustProxy: true` was a rate-limit bypass.** Fastify took the leftmost
   `X-Forwarded-For` value, which is client-controlled, so a guest could have
   forged a fresh source address per request and walked through the per-IP limit
   on the event code. Now trusts one hop from loopback only, which is where
   Caddy is.
2. **The harness was double-counting init segments.** Concurrent segment fetches
   for one track all raced past a plain `have` check, fetching the init segment
   nine times per track and inflating bandwidth by roughly 50 % — 540 requests
   where 360 was correct. Deduped on a promise, as the guest's cache already was.
3. **Time to ready was measuring the wrong interval.** Measured from process
   start, a client that connects before the DJ queues anything reports its idle
   wait as download latency: the first run showed 28 s. It now runs from the
   moment the client learns of a playable track, which is the number the venue
   test needs.

## Re-running

```bash
npm run harness -- --clients 30 --stagger 0 --seconds 60
```

Needs `DISCO_JOIN_ATTEMPTS_PER_MINUTE` raised on the server, since 30 sessions
from one address is exactly what the per-IP limit exists to stop.
