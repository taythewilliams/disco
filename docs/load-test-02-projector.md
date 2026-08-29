# Load test 02 — projector plus server plus 30 clients, loopback

Phase 3's load test (BUILD.md Part G), 2026-08-29. Follows
[load test 01](load-test-01-virtual-clients.md), which measured the server and
30 virtual clients with no projector.

**The question this run exists to answer:** can one MacBook run the server, serve
thirty clients *and* drive the full-screen projector visualiser, or does the
display have to move to a second machine? v4 D8 flagged this as a real risk and
built `/display` as a WebSocket client specifically so that moving it would be a
config change rather than a rewrite.

**This is still not the venue test.** Everything below ran over loopback: no
radio, no contention, no distance. The bandwidth figures are an upper bound on
what the software *asks for*, not a prediction of what the air will deliver. The
access-point run belongs to Phase 4.

## Setup

- MacBook, Apple M1 Pro, 16 GB, macOS 26.5.2, Node 24.18.1.
- Server: `packages/server`, SQLite manifest, `media/` on local disk, venue
  profile `workshop`.
- Library: three ingested test tracks, 90 s each, AAC-LC 192 kbps, four ~25 s
  fMP4 segments per track, beat grids detected by aubio at 120.3, 128.1 and
  96.1 bpm against synthesised material generated at 120, 128 and 96.
- Projector: `/display?debug=1` in a browser, signed in with the display code,
  rendering the beat-grid visualiser at 2124 × 972 device pixels.
- One real browser guest running the PWA with audio, alongside the virtual
  clients.
- Virtual clients: `packages/server/test/harness`, 30 instances, arriving in a
  rush (`--stagger 0`).

```bash
DISCO_EVENT_CODE=… npx tsx packages/server/test/harness/run.ts \
  --clients 30 --stagger 0 --seconds 45
```

## Results

| | A: rush, default cap (12) | B: rush, default cap (12) | C: rush, cap forced to 1 |
|---|---|---|---|
| Duration | 45 s | 30 s | 35 s |
| Clients clock-locked | 30 / 30 | 30 / 30 | 30 / 30 |
| **Clock offset spread** | **1.0 ms** | **0.8 ms** | **1.4 ms** |
| Offset standard deviation | 0.2 ms | 0.1 ms | 0.2 ms |
| RTT median / p95 | 0.4 / 0.8 ms | 0.3 / 0.7 ms | 0.3 / 1.1 ms |
| Time to ready median / max | 251 / 253 ms | 250.5 / 251 ms | 250 / 251 ms |
| Downloaded | 129.9 MB / 450 req | 129.8 MB / 390 req | 195.9 MB / 450 req |
| Aggregate throughput | 23.1 Mbps | 34.5 Mbps | 44.7 Mbps |
| Failed requests | 0 | 0 | 0 |
| Protocol errors | none | none | none |

Readiness, read off the dashboard's own API during run A: **31/32 ready** on every
track in the horizon, held for the whole run — the 30 virtual clients plus the
real browser guest, with the one straggler being a client still filling its
buffer at the sample.

## What it says

**The visualiser is not the bottleneck, and the display can stay on the MacBook.**
One frame of the projector's beat visualiser costs **0.005–0.018 ms of CPU** at
2124 × 972 (measured over 1 000 frames, idle and again mid-run under the
30-client rush). At 60 Hz that is under 0.1 % of one core. Observed frame rate
was 120 fps while the browser was compositing.

Frame *cost* rather than frame *rate* is the honest measurement here, because
the browser throttles `requestAnimationFrame` in a window that is not
compositing — a low rate in that state means the browser is idle, not busy. The
debug build exposes `window.__discoFrameCostMs(frames)` on `/display?debug=1`
for exactly this, and it runs the same `frameFor`/`render` the projector runs.
This retires the "projector visuals starve the server" risk on this hardware.
It does not retire the GPU-side question on the venue's actual projector
resolution, which the Phase 4 rehearsal covers.

**Clock sync is still not the problem.** Sub-1.5 ms spread across 30 clients with
the projector rendering, against the 2–5 ms the budget allows (v4 Part 0).
Calibration variance remains the dominant term, and Spike 3 remains the
highest-value spike.

**Admission control binds, orders correctly, and starves nobody.** At the default
cap of 12 concurrent transfers the queue never formed: a ~600 kB segment
completes in about a millisecond on loopback, so the cap has nothing to hold
back. Forcing the cap to 1 made it bind hard — **310 transfers had to wait** —
and the outcome was still 30/30 clients ready in 250 ms, **zero** admitted over
capacity (nobody waited past the 15 s valve) and **zero** failures. Aggregate
throughput went *up* under the tighter cap, which is what serialised transfers
on a link with no contention look like; on the venue's radio it will not.

The listeners-before-joiners ordering therefore has no evidence *from this run* —
it cannot have, because nothing ever queued at the default cap. It is covered by
unit tests (`packages/server/test/downloads.test.ts`), and the venue run is where
it gets its real exercise. The dashboard shows `queuedTotal` for this reason: it
is the number that says whether the cap is doing anything at all.

**A server kill is survivable, and the projector survives it better than expected.**
With the server killed mid-track:

- The guest PWA kept playing and showed "Playing · reconnecting" (D17).
- The projector kept rendering the current track's visuals at ~105 fps, driven
  by its own clock offset and the last `state` it received, and showed
  "reconnecting".
- Both reconnected on their own within a few seconds of the server coming back,
  with no interaction.

This answers BUILD.md Part I question 2 — "should the projector survive a server
outage?" — with a qualified yes: it degrades rather than freezing, and stays
correct until the next track boundary, after which it would show the wrong
track. That is the right shape for the failure and no further work is proposed.

**The venue profile survives a restart.** Projector offset was set to 85 ms from
the dashboard slider, the server was killed and restarted, and it came back with
`projectorOffsetMs=85` in the boot log. Nobody should measure a projector offset
twice (D8).

## Exercised end to end during this run

- Guest comment → DJ review stack → approve → **on the projector**, escaped as
  React children (D7).
- **Panic hide**: one tap removed the feed from the projector and left the
  visuals and now-playing intact; the dashboard status bar showed "feed hidden"
  for as long as it was engaged.
- Per-track readiness bars, lead-time badges, and the transport pending count.
- Media now requires a session: an unauthenticated `GET` of a segment returns
  401, so the event code gates the music and not only the timeline.

## Still outstanding for the Phase 3 milestone

The milestone is "10+ devices, 45 minutes continuous, with a deliberate server
kill, a headphone swap, a channel switch, a review-mode approval round trip, and
an open-mode panic-hide, with the projector running." What this run did **not**
cover:

- **Ten or more real devices for 45 continuous minutes.** 30 virtual clients plus
  one real browser client is not the same thing, and it is the part that needs
  people.
- **A headphone swap.** Needs real hardware and a real ear.
- **A channel switch.** v1 ships one channel behind the N>1 flag (D3), so there
  is nothing to switch to yet.
- **Open-mode panic-hide.** The panic control was exercised in review mode; the
  open-mode path shares the same code (one pipeline, a boolean on the hold
  stage) but has not been run with auto-accept on.
- **The access point.** Not yet purchased, so the 30-client bandwidth question
  remains where load test 01 left it.
