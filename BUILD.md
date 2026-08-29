# Disco — Build Plan

Execution plan for the design in [synced-audio-plan-v4.md](docs/synced-audio-plan-v4.md).

That document is the **decision register** — it says *what* and *why*, and stays the source of truth for rationale. This document is the **build plan** — repo shape, protocol contract, ordered work, and pass criteria. Where the two disagree, v4 wins on intent and this file wins on mechanics. Decision references like `D7` point back to v4.

---

## Part A — Decisions locked this session

| Question | Answer | Consequence |
|---|---|---|
| Client stack | React 19 + Vite + TypeScript | `vite-plugin-pwa` for manifest/service worker. Guest shell budget < 1 MB gzipped (D4) — enforced in CI. |
| Channels at v1 | **One.** N>1 modelled throughout, shipped behind a flag | `channelId` on every message and row from day one (D3). No channel-pick UI in v1 onboarding. |
| Library size | **Thousands of tracks** | Promotes dashboard search + BPM/key sort into Phase 3 scope. Ingest must be resumable, idempotent, parallel (D10). |
| Target date | None fixed | Keep v4's risk-ordered sequencing. Phase 0 first, ship on milestones not dates. |
| DNS | ~~**Cloudflare** for the zone~~ → **superseded: zone stays in cPanel, certificate issued manually** | The zone carries live mail (`MX` to the host, SPF, DKIM) and cPanel's DNS has no Caddy provider module, so moving it would put the domain's email in the path of a party for no automation gain. Manual DNS-01 instead, renewed before each event. See [Spike 4](docs/spikes/04-https-lan.md). |

### Not yet in hand

- **Access point.** Purchase is a Phase 0 action item (D13). Until it arrives, Spike 2 runs on existing Wi-Fi — valid for measuring *skew*, worthless for the 30-client bandwidth question, which moves to Phase 3's load test.
- **5–8 people for Spike 3.** The highest-value spike (calibration variance dominates the error budget, Part 0) is also the only one you cannot run alone. Recruit before you need them.

### Engineering choices made by default

Overrule any of these freely; none are load-bearing on the design.

- **Runtime:** Node 22 LTS, TypeScript throughout, ESM.
- **Server:** Fastify (static serving with HTTP range support for segments) + `ws` for WebSocket. Not Socket.IO — the protocol is small, custom, and benefits from no framing overhead on the clock-sync path.
- **Store:** SQLite via `better-sqlite3`. Synchronous API is correct here: every query is local, small, and on the same box. Comments stay in memory (D7 — ephemeral).
- **Validation:** Zod, schemas defined once in `shared` and used by both ends (D12).
- **Monorepo:** npm workspaces. No Turborepo/Nx — five packages doesn't justify it.
- **Tests:** Vitest for units; a Node-based virtual-client harness for multi-client behaviour (Part E).

---

## Part B — Repo layout

```
disco/
├── package.json                 npm workspaces root
├── BUILD.md                     this file
├── docs/
│   ├── synced-audio-plan-v4.md  decision register
│   ├── spikes/                  one results file per spike, committed
│   └── runbook.md               pre-event checklist (Phase 4)
├── packages/
│   ├── shared/                  protocol types, Zod schemas, clock math, constants
│   ├── server/                  Fastify + ws + SQLite
│   └── ingest/                  CLI: ffmpeg / loudness / beat detection
├── apps/
│   ├── guest/                   the PWA (React + Vite + vite-plugin-pwa)
│   └── host/                    DJ dashboard + /display route (React + Vite)
├── ops/
│   ├── Caddyfile.example
│   └── scripts/                 cert check, venue preflight, AP notes
└── media/                       gitignored: source audio, segments, disco.db
```

**Why `host` is one app with two routes.** The dashboard and `/display` both run on the trusted network, on machines you control, and share the channel-colour and now-playing components. The guest PWA is a separate Vite app specifically so the dashboard's weight — tables, charts, search — can never leak into the shell that 30 phones fetch at the door (D4, D15). `/display` remains a plain WebSocket client of the same feed, so relocating it to a second machine stays a config change (D8).

**`shared` is the contract.** Both ends import the same Zod schemas. A protocol change that breaks a client fails to typecheck rather than failing at 11pm.

---

## Part C — The protocol contract

Build this first, in `packages/shared`, before any server or client code. Everything else is an implementation of it.

### Time base

```ts
// shared/time.ts — the single definition of "server time"
// Monotonic milliseconds from a fixed origin captured at server boot.
// NEVER Date.now(): a wall-clock jump mid-set desynchronises the entire room (D9).
const ORIGIN = /* captured once at boot */;
export const serverNow = () => ORIGIN + performance.now();
```

Clients hold `offsetMs` and compute `estimatedServerNow() = performance.now() + offsetMs`. Every scheduling decision goes through that one function.

### Message set

Guest → server:

| Type | Payload | Notes |
|---|---|---|
| `ping` | `{ t0 }` | Clock sync. Rate-limited hard (D12). |
| `subscribe` | `{ channelId }` | v1 always `"main"`. |
| `telemetry` | `{ offsetMs, rttMs, driftMs, calibrationMs, engine, bufferSec }` | No PII — random per-load client ID only. |
| `comment` | `{ text }` | ≤140 chars, validated server-side, rate-limited (D7). |

Server → client:

| Type | Payload | Notes |
|---|---|---|
| `hello` | `{ clientId, serverTime, config }` | |
| `pong` | `{ t0, t1 }` | Client stamps `t2` on arrival. |
| `state` | `{ channelId, trackId, startAtServerTime, paused, pausedAtPosition, queue[] }` | **The one message that matters** (v4 Part 2). |
| `trackMeta` | `{ trackId, durationMs, gainDb, bpm, beatGridOffsetMs, segments[], peaksUrl, artUrl }` | |
| `config` | remote config delta | D11. |
| `feed` | `{ items: [{ id, text, at }] }` | Dashboard + display only. |
| `error` | `{ code, message }` | Message strings server-driven (D11). |

DJ → server — **every one of these is authorisation-checked server-side** (D12):

`queue.set` · `transport.play|pause|skip|seek` · `comment.approve|reject|remove` · `feed.hide` · `config.set` · `resync`

### Authorisation model

Two roles on the connection, resolved at WebSocket upgrade and stored on the socket:

- `guest` — gated by the event code. May read state, subscribe, submit comments.
- `dj` — separate credential. Scoped `channels: string[]` from day one, even though v1 grants `["*"]` (D3, Part 5 Q1).

The check is a single `requireRole()` guard at the top of every mutating handler, with an inline comment explaining intent. **Never** enforced by hiding dashboard UI — assume someone opens dev tools and sends `{type:"transport.skip"}`. This is OWASP A01 and the most likely thing to actually go wrong.

---

## Part D — Phase 0: de-risk

No code depends on these, and their results change what you build. Run them in this order; 2, 3 and 5 can overlap.

### Spike 4 — HTTPS on the LAN · **start today**

The long pole. Start it before any other work.

**Step 0 — superseded. The zone does not move.** See [docs/spikes/04-https-lan.md](docs/spikes/04-https-lan.md) for what was done instead and why: the TXT record is added by hand in cPanel and Caddy is handed the resulting files. The steps below are kept for the day the zone does move — to Cloudflare, or to deSEC for a delegated `party.` subdomain, which is the upgrade path if manual renewal becomes annoying.

1. **Audit the existing Namecheap records first**, especially `MX`, `SPF`, `DKIM`, `DMARC`. Cloudflare's import scan catches most records but is not guaranteed complete, and Cloudflare Free only supports full nameserver delegation — partial/CNAME setup is a paid plan, so the whole zone moves. If the domain carries email you depend on, a missed MX or SPF record is the failure mode here, not anything to do with certificates.
2. Add the zone in Cloudflare, review the imported records against your audit, then change nameservers at Namecheap. Cloudflare emails when the zone goes active — usually well under an hour.
3. Add `party.<domain>  A  192.168.4.10` — **DNS-only (grey cloud), never proxied.** A proxied record makes Cloudflare answer with their own anycast addresses, so guests would resolve to a Cloudflare edge instead of the MacBook. This breaks silently and looks like a networking problem.
4. Create an API token scoped to `Zone:DNS:Edit` on **that one zone**. Environment variable, never in source (D12).

**Then:** static IP, Caddy with the Cloudflare DNS-01 plugin, local DNS override on the AP (deferred until the AP arrives — public DNS alone is enough to pass this spike).

Note that pointing a public A record at a private address is unusual but valid. Some resolvers implement DNS rebinding protection and will refuse to return it, which is exactly why the AP's local DNS entry is the primary path and public DNS is the fallback (D14 step 5). Do both.

**Pass criteria:**
- iPhone and Android both load `https://party.<domain>` with **no** certificate warning.
- A trivial service worker **registers** and survives reload. This is the real test — service workers refuse to register on an origin with a certificate error even if the user clicks through (D14).
- `navigator.storage.persist()` returns without throwing.
- Cert renewal path proven at least once (`caddy reload`, or force a renewal).

**Write up:** `docs/spikes/04-https-lan.md` — provider chosen, token scope, exact Caddyfile, and what broke.

### Spike 2 — two-phone sync

Hardcoded track, hardcoded start time, clock sync + `AudioBufferSourceNode.start(when, offset)`. One iPhone, one Android, wired headphones, no calibration.

**Measurement rig** — this is the part that's easy to get wrong. Don't try to eyeball it:
1. Wired earbuds from both phones, placed together against a single recording microphone (a third phone recording is fine).
2. Play a track with a sharp transient — a bare kick works.
3. Open the recording in Audacity, zoom to the transient, measure the offset between the two attacks.

Accurate to ~1 ms, costs nothing. Speaker output would measure a different output path, so use the earbuds.

**Pass:** measured skew **< 50 ms**, pre-calibration, sustained over three minutes.

### Spike 3 — calibration variance · **highest value**

The kick/hi-hat two-bar loop, on-phone visual pulse, slider (D1). 5–8 people, **the same headphones and the same phone**, identical spoken instructions.

**Measure the standard deviation of their answers, not the mean error.** Per v4 Part 0, systematic bias cancels completely — a method that's consistently 30 ms off is better than one that's accurate on average but scattered. Record `AudioContext.outputLatency` on every device you can get your hands on while you're at it, to find out what Layer 1 is actually worth.

**Pass:** σ **< 25 ms**. Between 25 and 40 ms, tighten the method (longer loop, clearer pulse, better instructions) and re-run. Above 40 ms, the whole error budget needs revisiting before Phase 1 — this is the one result that can change the architecture.

### Spike 5 — perceptual validation

Two people, deliberately offset audio, dancing. Walk the offset up in 20 ms steps until it reads as wrong. Twenty minutes. Sets the real target that Spike 3 is measured against, and may well prove the plan's 50–100 ms assumption pessimistic.

### Spike 1 — iOS background audio (informational, non-blocking)

Matrix: Safari tab vs installed PWA × WebAudio vs MediaElement × screen locked vs app-switched. Plus Wake Lock reliability and resume-on-unlock behaviour.

**Output is a line of guest onboarding copy** — "keep the app open" vs "pocket your phone freely" — and which engine the capability detector should prefer on iOS. Not a gate (D16).

### Non-code action items

- [ ] Buy the AP (Ubiquiti U6/U7 or Omada class, D13).
- [ ] Recruit 5–8 people for Spike 3.
- [x] ~~Move the zone to Cloudflare~~ — not needed; certificate issued by manual DNS-01 against the existing cPanel zone (Spike 4, passed 2026-08-29).
- [ ] **Renew the certificate before every event** — `ops/scripts/renew-cert.sh`, then `npm run cert-check`. Manual issuance means nothing renews on its own.
- [ ] **Check the AP supports local DNS entries before buying.** The venue's uplink router cannot be the resolver guests are handed: DNS rebinding protection strips private-address answers, measured on real hardware in Spike 4.
- [ ] Confirm the music library's legal footing matches v4's assumption — private, non-ticketed, not publicly advertised. If any of those change, get jurisdiction-specific advice before the event.

---

## Part E — Phase 1: core engine (~2.5 weeks)

**Goal: four phones, mixed platforms, three consecutive tracks gapless, sustained sync, zero intervention.**

**1. `shared` first.** Protocol types, Zod schemas, `serverNow()`, clock-offset math, drift thresholds, constants. Unit-tested before anything imports it — the RTT-filtering median and the position math are pure functions and deserve real tests.

**2. Ingest** (`packages/ingest`). CLI over a directory. Per track: AAC-LC 192 kbps fMP4, ~25 s segments · exact frame duration · EBU R128 integrated loudness → gain to −14 LUFS · BPM + beat grid · waveform peaks · artwork at two sizes.

Because the library is thousands of tracks, three requirements that would otherwise be optional:
- **Idempotent and resumable**, keyed on source-file content hash. Re-running skips completed work.
- **Worker pool** across cores, with a progress bar and a failure log that doesn't halt the run.
- **Manifest into SQLite** as the single source of truth for the dashboard.

**3. Server.** Fastify static segments with range support and immutable cache headers (D4) · `ws` endpoint · clock sync handler · per-channel state machine · SQLite schema · Zod validation on every inbound message, rejecting unknown types rather than ignoring them.

**Path traversal:** every track ID → path lookup resolves and then verifies the result is still inside `media/`. Never concatenate client input into a path (D12, OWASP A01).

**4. Client engine** (`apps/guest`, headless-ish at this stage). Clock sync with the 25th-percentile RTT filter · JIT prefetch within the horizon · chunked decode (~25 s segments, 2–3 resident — a five-minute stereo track is ~105 MB decoded, so this is not optional) · both engines behind `PlaybackEngine` including `scheduleOverlapping` · drift correction via `playbackRate` under 60 ms, hard reschedule over.

**5. Minimal DJ UI.** Play, pause, skip, one channel. Ugly is fine.

**6. Virtual-client harness** (`packages/server/test/harness`). N simulated clients in Node — real WebSocket connections, real clock sync, real segment fetches, no audio. Lets you exercise 30-client server behaviour, bandwidth shape, and the download-prioritisation logic long before you have 30 phones. This pays for itself repeatedly; build it in Phase 1, not when it's urgent.

---

## Part F — Phase 2: guest experience (~2 weeks)

**Goal: someone who has never seen the app goes QR scan → synced music in under 60 seconds, unaided, on both platforms.**

- Calibration: `outputLatency` seed → server-driven device preset table → loop + slider refinement → local persistence → **permanently visible** recalibrate button (route-change detection is unreliable; a headphone swap moves latency ~200 ms).
- The arrival flow (D4): shell loads → install prompt → calibration begins immediately from the bundled loop while segments download behind it. **The guest is never in silence.**
- PWA: manifest, `display: standalone`, full icon set, service worker (cache-first shell, never cache the WS endpoint), Android `beforeinstallprompt` button, iOS illustrated share-sheet walkthrough. Note the installed iOS PWA re-fetches the shell into its own storage container — keep it small.
- Now playing · volume · mid-track join with a visible "catching up — 20s" indicator · Wake Lock · Media Session metadata · LUFS gain applied.
- Comment field: 140-char cap, client-side rate limit (the server enforces the real one).
- Client autonomy (D17): cache the queue and schedule, keep playing through a server outage with a subtle reconnecting indicator.

**Shell budget check in CI.** Fail the build if the guest entry bundle exceeds 1 MB gzipped.

---

## Part G — Phase 3: host tooling and projector (~2 weeks)

**Goal: 10+ devices, 45 minutes continuous, surviving a deliberate server kill, a headphone swap, a review-mode approval round trip, and an open-mode panic-hide — with the projector running.**

**Dashboard.** Per-channel queue · readiness bars ("28/30 ready" — the single widget that prevents most live failures) · transport · per-track gain trim · resync-all · client telemetry panel (offset, RTT, drift, calibration, engine, channel, buffer per device) · remote config.

**Library UI — expanded scope because the library is thousands of tracks.** Search, BPM and key sort, saved crates, and a virtualised list. Budget real time for this; it was the deferred item in v4 and the answer promoted it.

**Comment pipeline — one code path, both modes** (D7): validate → filter → hold-or-promote → render, with the moderation mode as a boolean on the hold stage.
- Review mode: card stack with thumb-sized approve/reject, pending count on the transport view, ~10-minute auto-expire.
- Open mode: **persistent hide-the-feed panic control**, reachable without scrolling or navigating. Per-item removal, newest first. Hard rate limit.
- Persistent active-mode indicator. A mode you can't see at a glance is a mode you'll forget you're in.
- **Escape on output, everywhere.** Never `innerHTML` with guest text on dashboard or projector. Strip control characters and normalise Unicode — RTL-override and combining-mark stacking wreck a layout and sail straight past a wordlist filter. This is the system's most likely injection vector (OWASP A03).

**`/display` route** as a WebSocket client of the same feed: beat-synced visuals from the ingested beat grid, now playing in channel colours, moderated feed, optional join QR.

**Projector global offset slider**, stored per venue. One number for the whole room (D8).

**Security pass, all in this phase:** server-side role enforcement on every mutating message · schema validation with unknown-type rejection · per-connection rate limits on ping and comment · path-traversal guard · no secrets in source (DNS token, event code, DJ credential from env) · Node as non-root on a high port bound to the LAN interface, Caddy owning 443 · logs record connection events and errors, never payloads and never comment text.

**Load test:** full-screen WebGL visualiser + server + 10 real clients + the virtual harness at 30, all on the one MacBook. If it struggles, move `/display` to a second machine — which the WebSocket-client design makes a config change.

---

## Part H — Phase 4: venue hardening (~1 week + rehearsal)

- AP configured: 5 GHz, venue channel scan, 40 MHz width, legacy low data rates disabled, client isolation on **with the server verified reachable**, DHCP reservation for the MacBook, local DNS entry.
- Server wired to the AP. Never on Wi-Fi.
- 4G/5G uplink up, so phones' OS connectivity checks pass and don't silently fall back to cellular.
- Certificate renewed **before** the event with `ops/scripts/renew-cert.sh`, then verified with `npm run cert-check`. Issuance is manual (Spike 4), so nothing renews on its own and there is no API to fail quietly — the failure mode is simply forgetting. An expired certificate at the door is the same failure as a self-signed one: no service worker, no PWA.
- Projector offset calibrated in the actual room, on the actual projector.
- QR assets printed large: Wi-Fi join and app URL, on every table.
- Failure UX written and tested: server unreachable, track not ready, storage full, install declined.
- `docs/runbook.md` — the pre-event checklist, in order, with nothing left to memory.

**Milestone: rehearsal at the real venue with 15+ people who have never seen the app. Watch them onboard without helping. Every question they ask is a bug.**

---

## Part I — Still open

Carried from v4 Part 5, minus the two answered this session.

1. **One DJ across all channels, or one per channel?** Auth model is scoped per-channel now; the UI decision waits. Sharpens if a second channel ever ships — with a single moderator, whose dashboard do comments land in?
2. **Should the projector survive a server outage?** Phones keep playing (D17); the display is a WebSocket client and would freeze. Probably acceptable, but make it a conscious decision rather than a discovery.
3. **Venue-scoped profile.** Projector offset is already per-venue. Worth saving AP channel, room layout, default moderation mode alongside it?
4. **Default moderation mode.** Event config, set before doors — but pick a default now so the first run isn't decided under pressure. Review mode is the safer default.

---

## Part J — Definition of done, per phase

A phase is complete when its milestone passes **unaided and unrehearsed**, and its spike or load-test results are written up in `docs/`. Estimates are ordering hints, not commitments — there's no fixed date, and the sequencing is by risk retired, not by calendar.
