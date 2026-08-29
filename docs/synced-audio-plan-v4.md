# Local-Network Synced Audio for Events — Plan v4 (PWA)

**Concept:** An installed PWA plays owned music files in sync across 30+ phones on a local network. Headphones only, dancing event. A DJ queues tracks with several minutes of lead time. A projector displays beat-synced visuals and a moderated guest comment feed. Everything is served from a MacBook on-site.

**Changes from v3:** multi-channel prepared throughout; guest comment feed added; projector display added as a first-class component; Spike 1 downgraded from a gate to an informational spike.

---

## Part 0 — The Reframe That Matters

### Spread, not absolute latency

This is a dancing event with no sound in the room. That combination has a consequence worth stating plainly:

**A uniform delay is invisible. Only the spread between guests matters.**

If every phone in the room delivered audio to the ear exactly 200 ms late, nobody could tell — there is no reference to be late against. Thirty people dancing 200 ms behind the server clock, together, look perfectly in time. What ruins it is one person at 40 ms and another at 240 ms.

Three things follow:

1. **Calibration needs precision, not accuracy.** If the human calibration method has a systematic bias — everyone lands 30 ms early — that bias cancels completely. Spike 3 should measure the **standard deviation** of people's answers, not their error against ground truth. This is a much easier target to hit.
2. **Absolute latency is free.** You can add buffer, delay the start, or pad the schedule wherever it helps, without cost.
3. **The projector needs one global offset, not per-guest calibration.** See D8.

### Revised sync budget

| Error source | Contribution to **spread** |
|---|---|
| Clock sync | 2–5 ms |
| Scheduling precision | 5–10 ms (Web Audio) / 30–50 ms (`<audio>`) |
| Calibration variance between guests | 20–50 ms ← **the dominant term** |
| Drift between corrections | 5–15 ms |
| **Realistic spread** | **35–80 ms** |

For observed dance movement, asynchrony generally becomes noticeable somewhere around 50–100 ms. You are sitting right at that boundary, which means **calibration variance is the single number worth optimising.** Every other term is already small.

Spike 5 validates this against real bodies rather than my estimates.

---

## Part 1 — Decision Register

### D1. Calibration — three layers

**Ruled out: camera-based calibration.** A camera measures light; the latency to measure is on the audio path. Camera glass-to-JS latency is roughly 50–150 ms, varies with lighting (and the venue is dark), and isn't separable into components. The microphone variant fails too — requesting mic access on iOS typically switches Bluetooth from A2DP to the bidirectional call profile, which has entirely different latency, so you'd measure a mode nobody listens in.

**Layer 1 — automatic seed.** Read `AudioContext.outputLatency` where available. Android Chrome reports a value partially reflecting the real audio path; Safari is unreliable. Treat it as a hint, never truth. Where present it beats a generic preset.

**Layer 2 — device presets (optional step).** Wired / AirPods / Generic Bluetooth / Low-latency Bluetooth. Build the table from real Phase 0 measurements and make it **server-driven** (D11) so a bad value can be corrected mid-event.

**Layer 3 — human refinement, part of onboarding.** A repeating two-bar loop — kick on the beats, hi-hat on the offbeats — with a visual pulse on the beat. The guest drags a slider until sound and pulse read as simultaneous.

Design points:

- **Visual on the guest's own phone, not the projector or host screen.** You control both screen and audio on that device, phone display latency is small and roughly uniform, and it removes any need for line of sight across a dark room. Guests can recalibrate anywhere, anytime.
- **A repeating loop, not a single click.** Rhythmic alignment judgement is far better than one-shot simultaneity because there are several bars to lock in. Expect ±30 ms from non-musicians, ±10 ms from musicians.
- **A slider, not tap-to-the-beat.** Tapping folds in motor latency, and people carry a personal bias of tens of milliseconds.
- **Minimise variance, not bias.** Identical instructions and an identical loop for everyone. A consistent method that's systematically 30 ms off is *better* than a variable method that's accurate on average.

**Persistence:** store locally, auto-apply on return. Route-change detection is unreliable on the web, so the recalibrate button gets a permanent, obvious home — swapping headphones shifts latency by ~200 ms and you cannot count on detecting it.

**Bundle the calibration loop in the app shell.** Few hundred kilobytes, needs to be instantly available on arrival (D4).

### D2. Playback engine — build both

One interface, two implementations:

```ts
interface PlaybackEngine {
  schedule(track: TrackRef, atServerTime: number, fromPosition: number): void;
  scheduleOverlapping(track: TrackRef, atServerTime: number, fadeMs: number): void;
  correctDrift(errorMs: number): void;
  getCurrentPositionMs(): number;
  getMeasuredSkewMs(): number;
}
```

**`WebAudioEngine`** — `AudioBufferSourceNode.start(when, offset)`. Sample-accurate, ~5–10 ms precision. Vulnerable to iOS suspending the context when backgrounded.

**`MediaElementEngine`** — `<audio>` steered by `currentTime` seeks and `playbackRate`. Coarser (~30–50 ms) but survives lock screen and gives real lock-screen controls via Media Session.

Runtime capability detection, with a **server-driven override** to force one engine room-wide from the dashboard. Both report `getMeasuredSkewMs()` as telemetry so the eventual decision to drop one is evidence-based.

**Two overlapping sources are required from day one** (D5, D6) — `scheduleOverlapping` serves both the future crossfade and channel switching.

**Memory:** `decodeAudioData` returns Float32, so a five-minute stereo track is ~105 MB decoded. Chunked scheduling over ~25 s segments with two or three resident solves this and gives gapless playback for free.

### D3. Multi-channel — prepared from the start

**Decided: model fully, build the server for N channels, ship v1 with N=1 behind a flag.**

What "prepared" concretely means:

- **`channelId` on every message, every queue, every playback state.** Retrofitting this is a protocol rewrite; including it now costs a field.
- **Server holds N independent timelines.** Each channel has its own queue, its own `startAtServerTime`, its own transport state.
- **Client subscribes to exactly one channel** and prefetches only that channel's horizon.
- **Visual identity per channel** — the colour-coded-headset equivalent. Make the entire phone UI the channel colour so people can see across a room who's on what.

Three consequences worth deciding before you build:

**Bandwidth multiplies.** N channels means N independent prefetch streams across the room. With bandwidth already the tight constraint (D4), this matters. **Mitigation: clients prefetch only their own channel.** Switching channels then costs a short buffering pause — reuse the arrival flow from D4, a few seconds, with a progress indicator. Don't try to keep all channels warm.

**Channel switching is a crossfade.** Fade out the old channel, fade in the new, using `scheduleOverlapping`. Same machinery as D6's crossfade. Nice reuse.

**Who runs the channels?** One DJ managing N queues, or N DJs each with their own dashboard session? The second needs per-channel auth scoping in the dashboard. **Unanswered — see Part 5.** Build the auth model to allow per-channel scoping even if v1 grants everything to one credential.

### D4. Arrival experience — the 15-second window

**No pre-caching days ahead.** A ~15-second buffering window on arrival, then music.

The window isn't dead time — **it's the onboarding.** Calibration takes 20–30 seconds anyway, so the two overlap:

```
0s    Scan QR → PWA loads (app shell < 1 MB)
2s    Add to Home Screen / install
5s    Channel pick (when N>1) → calibration begins,
      kick+hi-hat loop plays from the bundled asset
      ↓ (audio segments downloading in the background)
30s   Calibration done → join the live stream at the correct position
```

The guest is never in silence, because the calibration loop ships in the app shell.

**Bandwidth check.** At 192 kbps, 15 seconds at 5 Mbps per client fetches ~9 MB — about six minutes of audio. Ample individually. The pressure is *simultaneous* arrivals: 30 clients at 5 Mbps is ~150 Mbps aggregate, at the upper end of what a good 5 GHz AP delivers in practice.

**Mitigations:** arrivals are naturally staggered; immutable cache headers on segments; prefetch depth tunable via remote config. Add a server-side cap on concurrent segment downloads, and make it **prioritise clients already listening over clients joining.** A rush at the door must never starve the dance floor.

### D5. Prefetch — just-in-time within the horizon

DJ publishes a queue N tracks deep, per channel. Clients download inside the horizon and nothing beyond.

**Horizon of 5 tracks, minimum lead time of 3 minutes**, enforced by the DJ UI — a track can't play until it's been published long enough for the room to fetch it.

**Readiness tiers, surfaced to the DJ:** Ready (fully downloaded) / Partial (enough to start) / Not ready (needs mid-track join).

**Mid-track join must be graceful.** A guest arriving 40 seconds before a track starts gets progressive buffering and a visible "catching up — 20s" indicator. Never silence, never a silent failure.

**Per-track readiness bar on the dashboard** — "28/30 ready." This single widget prevents most live failure modes by letting the DJ hold a track when the room isn't there.

### D6. Transitions

**Gapless cuts for v1.** The engine supports scheduling two overlapping sources from the start, so fixed automatic crossfade is a v2 config change rather than an engine rewrite. The same machinery serves channel switching (D3).

DJ-controlled real-time crossfade stays out of scope — it partly reintroduces the live-mixing latency problem this architecture avoids.

### D7. Guest comment feed

**Decided: a free-text field on each device; submissions appear as a live feed on the host app and, once cleared, on the projector.** Doubles as song requests and social play. **The DJ is the sole moderator, and auto-accept is an event-level setting chosen before doors open, not a mid-set decision.**

Because these submissions land **on a projector in front of a room full of people** (D8), the stakes are higher than a host-only feed. Public message walls at events reliably attract someone testing what they can get away with, and alcohol shortens that timeline.

#### Two modes, one code path

Build this as a single pipeline with a boolean, not two implementations. Every submission flows through the same stages — validate, filter, hold or promote, render — and the setting only decides whether the hold stage is automatic.

| | **Review mode** (auto-accept off) | **Open mode** (auto-accept on) |
|---|---|---|
| Suits | Public, ticketed, or mixed crowds | Private events, known guests |
| Path | Submission → DJ queue → DJ taps → projector | Submission → filter → projector |
| Gate | The DJ | Profanity filter and rate limit only |
| DJ's recourse | Preventive | **Entirely retroactive** |

Set it in the event config alongside the channel count and the projector offset. Show the active mode persistently on the dashboard — a mode you can't see at a glance is a mode you'll forget you're in.

#### Open mode needs a panic control

With auto-accept on, the automated filter is the only thing standing between a guest and the projector, and the DJ is busy. Retroactive removal has to be genuinely fast:

- **Hide-the-feed button.** One tap removes the comment panel from the projector entirely, leaving visuals and now-playing intact. This is the "something is on screen and I need it gone" control, and it must be reachable without scrolling or navigating. Make it a persistent element of the dashboard, not a menu item.
- **One-tap removal per item.** The dashboard shows what's currently on the projector, newest first, each with a delete control.
- **Rate limit hard** — a few submissions per minute per client. Under auto-accept a flood goes straight to the wall, so this is a display-integrity control, not just server protection.
- **Profanity filter as the automated gate.** Be realistic about it: wordlist filters are defeated trivially by spacing and substitution, and they catch the lazy majority rather than anyone determined. Treat it as reducing volume, not as a guarantee, and don't let its presence justify skipping the panic control.

#### Review mode needs to be glanceable

When the DJ is the only moderator and is also running music, the queue has to survive being ignored for twenty minutes:

- **A single card stack with large approve and reject targets**, not a table. Thumb-sized, usable while doing something else.
- **A pending count visible from the transport view** so the DJ knows when it's worth looking.
- **Auto-expire pending items after ~10 minutes.** Without this, a busy stretch produces forty stale comments and the DJ faces a wall of context-free text from three tracks ago. Expiring quietly is better than a backlog nobody will clear.

#### Shared rules, both modes

- **Anonymous only. No nicknames, no identifiers.** Names are the main route from comment wall to targeted harassment, and it preserves the project's no-PII property (D12). Adding nicknames later is a deliberate decision with a moderation surface attached, not a drift.
- **140-character cap**, enforced server-side as well as in the field. Fits the projector, limits damage.
- **Ephemeral.** Delete the feed after the event. Don't accumulate guest text you never intended to keep.

#### Security — the project's first user-generated content

- **Escape on output, always.** Never `innerHTML` with guest text on the dashboard or the projector. Use `textContent` or the framework's default escaping. Guest text rendered on a projector is a live XSS target and the most likely injection vector in the system (OWASP A03).
- **Validate and length-check server-side**, not just in the client field.
- **Strip control characters and normalise Unicode.** Right-to-left override characters and combining-mark stacking are the standard way to wreck a display layout, and they sail past a profanity filter.

**Song requests:** free text is right for v1. The DJ reads it and decides. A library-search-backed request mode is a later refinement.

### D8. Projector display

**Decided: a separate display driven by the host app, shown on a projector.**

**Implementation:** a `/display` route opened in a second browser window, fullscreened on the projector output. macOS handles the second display natively. **Build it as a WebSocket client of the same feed the phones use** rather than reading in-process state — it's the same protocol, it makes the display trivially portable to a second machine if the MacBook struggles, and a future Art-Net/DMX light bridge becomes the same component with a different renderer.

**Content:**
- Beat-synced visuals driven by the **BPM and beat grid from ingest** (D10). This is where that decision pays off immediately rather than someday.
- Now playing, per channel, in channel colours.
- The moderated comment feed (D7).
- Optionally a join QR code during quiet moments.

#### Your timing question, answered

You intuited that the projector needs its own sync step. It does — but only **one global offset, set once at setup.** Here's why.

After calibration, each guest's audio is aligned to their own phone screen, and every phone screen is aligned to the shared clock. So audio-in-ear ends up aligned to server time across all guests, offset only by phone display latency, which is small and roughly uniform — a systematic bias, and per Part 0, systematic bias cancels.

The projector is driven by the MacBook, which *is* the clock source. Its only error is display latency: projector input lag plus compositor plus vsync, roughly 20–80 ms depending on the projector. That's also a constant.

So the mismatch between "beat in everyone's ears" and "beat on the projector" is a **single fixed number** — the sum of two constants. One host-side slider, adjusted at setup, corrects it for the entire room.

**How the host sets it:** stand in the room wearing calibrated headphones, watch the projector, drag until the visual pulse matches the beat. Twenty seconds, once per venue. Store per-venue, since projector lag varies by unit.

**Performance flag:** a full-screen WebGL visualiser, plus the server, plus serving 30 clients, all on one MacBook may or may not be comfortable. The WebSocket-client design means moving the display to a second machine is a config change, not a rewrite. Test this under load in Phase 3.

### D9. Clock sync and drift

NTP-style offset estimation over the control WebSocket:

```
rtt    = t2 - t0
offset = t1 - (t0 + t2) / 2
```

- **`performance.now()`, never `Date.now()`** — wall-clock jumps mid-set would be catastrophic.
- 15–20 samples on connect; discard above the 25th-percentile RTT; median of the survivors. Low-RTT samples are the accurate ones.
- Re-sample every 15 s, smooth with a slow filter, never step-correct a running estimate.
- LAN RTT of 2–20 ms gives offset accuracy in the low single-digit milliseconds.

**Drift correction:** fine (< 60 ms) via `playbackRate` at ±0.05–0.1%, bleeding off over ~20 s — inaudible, about 1 cent of pitch shift. Coarse (> 60 ms, or on resume from background) via hard reschedule. Log every correction; the history is your best live diagnostic.

### D10. Ingest pipeline

Offline, cheap now, expensive to re-run. Extract everything while you're already touching every file:

- **AAC-LC 192 kbps**, fragmented MP4, ~25 s segments. AAC because `decodeAudioData` supports it everywhere including Safari, with hardware decode.
- **Exact duration in frames.**
- **Integrated loudness (EBU R128 LUFS)** as a gain value, normalised to about -14 LUFS. Without it, track-to-track volume jumps become your most-complained-about issue, and Bluetooth volume controls are too clumsy for guests to fix.
- **BPM and beat grid** via aubio, Essentia or librosa. **Now directly required by the projector visuals** (D8), not speculative.
- **Waveform peaks** for the DJ scrubber.
- **Artwork** at two sizes.

#### Library size — what it actually affects

You weren't sure how big the library will be. The good news is it barely matters architecturally:

| | Impact of a large library |
|---|---|
| **Phone storage** | **None.** Phones only hold the prefetch horizon (~5 tracks, ~30 MB) regardless of library size. |
| **Venue bandwidth** | **None.** Depends on horizon depth and arrival rate, not catalogue size. |
| **MacBook storage** | Negligible. ~1.4 MB per minute, so 500 four-minute tracks is under 3 GB. |
| **Ingest time** | Real but one-time. Transcode plus LUFS plus beat detection runs at roughly 2–5× real-time per core. 500 tracks ≈ 33 hours of audio ≈ a few hours parallelised. Run it overnight. |
| **DJ dashboard** | **This is where it lands.** 50 tracks is a scrollable list. 2,000 tracks needs search, BPM and key sorting, and saved crates — real UI work, multiplied by multi-channel. |

**So: library size is a DJ-tooling question, not an architecture question.** You can defer it safely, and the only thing to decide early is whether Phase 3's dashboard needs a search UI or a list will do.

### D11. DJ dashboard and remote config

A web dashboard served by the same MacBook.

**Controls:** per-channel queue management, transport, per-track gain trim, resync-all, readiness bars, comment review stack with approve/reject, **persistent hide-the-feed panic control**, projector offset slider, and a persistent indicator of the active moderation mode.

**Event config, set before doors:** channel count, moderation mode (review or open), projector offset, prefetch horizon.

**Client telemetry panel:** every connected device with clock offset, RTT, drift error, calibration offset, active engine, channel, and buffer state. When something goes wrong at 11pm you need to know instantly whether it's one phone or all of them.

**Remote config:** prefetch horizon and depth, drift thresholds, clock-sync interval, **the device-preset offset table**, playback-engine override, projector offset, moderation mode, and all user-facing error strings.

### D12. Security

Thirty devices you don't control, on an untrusted network, at a party — now with user-generated content on a projector.

- **Least privilege:** Node app as a non-root user on a high port, bound to the LAN interface. Caddy handles 443. Never run the app as root to bind a privileged port.
- **No secrets in source.** DNS API token, event code and DJ credential from environment variables or a gitignored config. The DNS token scoped to a single zone.
- **Split the auth surface.** Guests get an event-code-gated role that can read state and submit comments. DJ controls sit behind a separate credential, **enforced server-side on every mutating message** — never by hiding UI. A web client is trivially inspectable; assume someone opens dev tools and sends `{type:"skip"}`. This is OWASP broken access control and the most likely thing to go wrong. Scope the model per-channel now (D3) even if v1 grants everything.
- **Escape all guest text on output** — dashboard and projector both. Never `innerHTML`. See D7.
- **Validate every inbound message** against a schema (Zod or similar). Reject unknown message types rather than ignoring them.
- **Rate-limit per connection** — clock-sync pings and comment submissions especially.
- **Path traversal:** resolve any track-ID-to-path mapping and confirm it stays inside the media directory. Never concatenate client input into a path.
- **No PII.** A random client ID per load is enough for telemetry. No names, no emails, no stable device identifiers, no comment nicknames. Comments are ephemeral and deleted after the event.
- **Logging:** connection events and errors, not payloads. Don't log comment text.
- Inline comments on the auth check and input-validation paths so intent is legible on review.

### D13. Network

- **AP:** a real one — Ubiquiti U6/U7, Omada or similar. One handles 30–50, but budget conservatively since audio crosses the venue network.
- **5 GHz**, clean channel scanned at the venue in advance, 40 MHz width.
- **Disable legacy low data rates** so a distant client can't consume disproportionate airtime.
- **Client isolation on**; confirm the server stays reachable.
- **Static DHCP reservation for the MacBook** — the certificate setup depends on a fixed IP.
- **Internet uplink: yes.** Satisfies OS connectivity checks so phones don't silently fall back to cellular, and makes DNS resolution work. A 4G router suffices.
- **Server wired to the AP.** Never on Wi-Fi — every byte would cross the air twice.
- **Multicast: no.** On Wi-Fi, multicast frames go out at the lowest basic rate, unacknowledged and un-retried. Unicast to 30 clients is genuinely better.

### D14. HTTPS on the LAN

Service workers, PWA install, Wake Lock and persistent storage all require a secure context. **Self-signed fails decisively: service workers will not register on an origin with a certificate error even if the user clicks through.**

Your domain is used for DNS and certificate issuance only. The app is served entirely from the MacBook.

**1. Fixed LAN IP.** DHCP reservation on the AP, e.g. `192.168.4.10`.

**2. Public DNS A record:**
```
party.yourdomain.com.   A   192.168.4.10
```
Pointing a public record at a private IP is unusual but valid, and standard for this situation.

**3. Certificate via DNS-01 challenge.** HTTP-01 requires public reachability; yours has none. **DNS-01 proves ownership via a temporary TXT record instead.** Caddy handles issuance and renewal:

```
party.yourdomain.com {
    tls {
        dns <your-provider> <api-token>
    }
    reverse_proxy localhost:3000
}
```

Needs a DNS provider plugin (Cloudflare, Route53, Namecheap and most others) and an API token scoped to *only* that zone — least privilege, in an environment variable, never in source control. `acme.sh` or certbot with a DNS plugin work equally well.

**4. Node listens on localhost:3000.** Caddy terminates TLS and proxies. Your app needs no TLS handling.

**5. Local DNS override on the AP.** Public DNS is the fallback, not the primary. Some resolvers implement **DNS rebinding protection** and refuse to return private IPs for public hostnames — this would break things silently for affected guests. Most prosumer APs let you add a static local DNS entry, answering authoritatively at the venue and bypassing upstream resolvers. **Do both.**

**6. Renew before every event.** Let's Encrypt certificates last 90 days; Caddy auto-renews *if* it can reach the DNS API, which needs the uplink. Verify manually on the pre-event checklist — an expired certificate at the door is the same failure as self-signed.

### D15. Installed PWA

- **Manifest** with `display: standalone`, full icon set, theme colour.
- **iOS:** manual trip through the share sheet. Build a clear illustrated prompt. Note an installed iOS PWA runs in **its own storage container with its own service worker registration**, separate from Safari, so the shell is fetched again after install. Keep it small.
- **Android:** `beforeinstallprompt` gives a proper install button.
- **Service worker** caches the app shell and calibration loop — cache-first for the shell, never cache the WebSocket endpoint.
- **`navigator.storage.persist()`** on first load. May be declined; treat as a bonus. Everything is re-fetchable from the LAN server anyway.

### D16. Background audio and screen lock

**Now an instructional question, not an architectural one.** The PWA is decided regardless; Spike 1 tells you what to tell guests.

Layered mitigations: installed PWA, `MediaElementEngine` + Media Session, Wake Lock (`navigator.wakeLock`, Safari 16.4+), and a now-playing visualiser people want to look at. Battery is handled operationally — charging stations, reduced brightness.

**Spike 1's output is a line in the guest onboarding copy**, e.g. "keep the app open" versus "feel free to pocket your phone." Run it early anyway, since it decides UI emphasis, but it no longer blocks Phase 1.

### D17. Client resilience

Clients cache the published queue and schedule. If the MacBook dies mid-set, phones with buffered audio **keep playing the known schedule** with a subtle reconnecting indicator. Drift accumulates slowly without clock updates, but a few minutes of gradual drift beats 30 people in sudden silence.

Nearly free given the architecture, and it converts the worst live failure into a minor one.

---

## Part 2 — Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  MacBook (wired to AP, static IP 192.168.4.10)               │
│                                                              │
│  Ingest (offline)                                            │
│    ffmpeg → AAC 192k → ~25s fMP4 segments                    │
│    + duration, LUFS gain, BPM/beat grid, peaks, artwork      │
│                                                              │
│  Caddy :443 — TLS via Let's Encrypt (DNS-01)                 │
│       └─ reverse_proxy → localhost:3000                      │
│                                                              │
│  Node :3000                                                  │
│    HTTP  : PWA shell · segments · manifest                   │
│    WS    : clock sync · per-channel state · control          │
│            · comments · telemetry                            │
│    Web UI: DJ dashboard  ·  /display route                   │
│    Store : SQLite (library, queues, config; comments in mem) │
└──────────────────────────────────────────────────────────────┘
     │ Ethernet          │ 2nd display (WS client on localhost)
┌────▼─────┐        ┌────▼──────────────────────────┐
│ Your AP  │←4G/5G  │ PROJECTOR                     │
│ + local  │        │  beat-synced visuals (BPM)    │
│ DNS entry│        │  now playing, per channel     │
└────┬─────┘        │  moderated comment feed       │
     │              │  ← single global offset slider│
     │              └───────────────────────────────┘
┌────┼────┬────┐         (future: Art-Net/DMX bridge,
│    │    │    │          same WS feed, different renderer)
▼    ▼    ▼    ▼
PWA PWA PWA PWA  … ×30+

  Per-client:
    service worker → app shell + calibration loop cached
    WS clock sync → server-time estimate
    channel subscription → JIT prefetch within horizon
    decode → PlaybackEngine (WebAudio | MediaElement)
    schedule at (startAtServerTime + position) − calibrationOffset
    drift monitor → playbackRate steering
    → gain (LUFS × user volume) → output
```

**The protocol still hinges on one message, now per channel:**

```jsonc
{
  "t": "state",
  "channelId": "main",
  "trackId": "abc123",
  "startAtServerTime": 1724832000123,  // when track position 0 occurs
  "paused": false,
  "pausedAtPosition": null,
  "queue": ["def456", "ghi789", "..."]
}
```

Any client, on any channel, joining at any moment, computes `position = nowServerTime − startAtServerTime` and knows exactly where to be. Late joins, reconnects, reloads, engine switches and channel switches are all the same code path. There is no special case, and that is the point.

---

## Part 3 — Build Plan

No fixed deadline, so phases are ordered by **risk retired per week** rather than by delivery date.

### Phase 0 — De-risk (~1 week)

**Spike 4 — HTTPS on the LAN. Start this first.** Domain, A record, DNS-01 certificate, Caddy, local DNS override. Confirm a phone loads with no warning and the service worker registers. **Front-load it because DNS propagation and provider plugin quirks eat days and none of it depends on your code.**

**Spike 2 — two-phone sync.** Hardcoded track and start time, clock sync plus scheduled playback. One iPhone, one Android. **Success: measured skew under 50 ms with wired headphones, pre-calibration.**

**Spike 3 — calibration variance.** Kick/hi-hat loop, on-phone visual pulse, slider. Have 5–8 people calibrate the same headphones. **Measure the standard deviation of their answers, not the mean error** — per Part 0, bias cancels and variance doesn't. Also record `AudioContext.outputLatency` on every device to see what Layer 1 is worth. This is the highest-value spike, because calibration variance dominates your budget.

**Spike 5 — perceptual validation.** Two people, deliberately offset audio, dancing. Find where it starts looking wrong. Calibrates the whole error budget against reality. Twenty minutes, and it might tell you the target is more forgiving than assumed.

**Spike 1 — iOS background audio (informational).** Test the matrix: Safari tab vs installed PWA, both engines, screen locked vs app switched, Wake Lock reliability, resume behaviour on unlock. **Output is a line of guest onboarding copy**, not a go/no-go.

### Phase 1 — Core engine (~2.5 weeks)

- Ingest pipeline including LUFS and BPM.
- Server: HTTP segments, WebSocket, clock sync, **per-channel** queue state, SQLite.
- Client: clock sync with filtering, JIT prefetch, chunked decode and scheduling, drift correction.
- **Both playback engines** behind `PlaybackEngine`, including `scheduleOverlapping`.
- Minimal DJ UI: play/pause/skip on one channel.
- **Milestone: 4 phones, mixed platforms, three consecutive tracks gapless, sustained sync, no intervention.**

### Phase 2 — Guest experience (~2 weeks)

- Full calibration flow: seed, presets, loop, slider, persistence, prominent recalibrate.
- The 15-second arrival flow with calibration overlapping the buffer.
- PWA manifest, service worker, install prompts both platforms.
- Now playing, volume, mid-track join with progress.
- Comment submission field with rate limiting and length cap.
- Wake Lock, Media Session metadata, loudness normalisation.
- **Milestone: a guest who has never seen the app goes QR scan → synced music in under 60 seconds, unaided, both platforms.**

### Phase 3 — Host tooling and projector (~2 weeks)

- DJ dashboard: per-channel queues, readiness bars, transport, telemetry panel, engine override, resync-all.
- Comment pipeline, one code path both modes: validate, filter, hold-or-promote, render. Review stack with large approve/reject targets, pending count, ~10-minute auto-expire. **Hide-the-feed panic control and per-item removal.** Persistent mode indicator.
- **`/display` route** as a WebSocket client: beat-synced visuals from the beat grid, now playing, moderated feed.
- **Projector global offset slider** and per-venue persistence.
- Remote config.
- Server-side auth split, message validation, output escaping, rate limiting.
- Concurrent-download cap prioritising listeners over joiners.
- **Load test: projector visuals plus server plus 10+ clients on the one MacBook.** If it struggles, move the display to a second machine — a config change by design.
- **Milestone: 10+ devices, 45 minutes continuous, with a deliberate server kill, a headphone swap, a channel switch, a review-mode approval round trip, and an open-mode panic-hide with the projector running.**

### Phase 4 — Venue hardening (~1 week + rehearsal)

- AP configuration, venue channel scan, uplink, DHCP reservation, local DNS entry.
- Certificate verified and renewed.
- Projector offset calibrated at the venue.
- QR assets: Wi-Fi join and app URL, printed large, on every table.
- Failure UX: no server, not ready, storage full, install declined.
- **Milestone: rehearsal at the real venue with 15+ people who have never seen the app. Watch them onboard without helping. Every question they ask is a bug.**

### Phase 5 — Post-event

Prioritised from what the event teaches. Likely: drop one playback engine on telemetry evidence, enable crossfade, enable a second channel, library search in the dashboard, Art-Net light bridge reusing the display component.

---

## Part 4 — Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Calibration variance too wide for dancing** | Medium | **Critical** | Spike 3 measures it early; identical method for everyone; presets as floor; Spike 5 sets the real target |
| Certificate or DNS failure at the venue | Medium | **Critical** | Local DNS override plus public A record; pre-event verification on the checklist |
| Service worker fails to register | Low | **Critical** | Valid certificate is the whole mitigation; verified in Spike 4 |
| **Offensive content on the projector (open mode)** | **High** | High | Panic hide-the-feed control; per-item removal; hard rate limit; profanity filter as volume reduction, not a guarantee |
| DJ can't keep up with review queue mid-set | **High** | Low | Glanceable card stack; pending count on the transport view; ~10-min auto-expire prevents backlog |
| Wrong moderation mode chosen for the crowd | Medium | High | Set in event config before doors; persistent mode indicator; panic control works in both modes |
| Guest skips calibration, dances out of sync | **High** | Medium | Sensible preset defaults; recalibrate always visible; calibration built into onboarding rather than optional |
| Simultaneous arrivals saturate the AP | Medium | High | Staggered arrivals; concurrent-download cap; listeners prioritised; prefetch depth tunable |
| Headphone swap mid-event breaks sync | **High** | Medium | Prominent recalibrate button; assume detection is unreliable |
| iOS suspends audio when pocketed | **High** | Medium | Spike 1 sets guest instructions; dual engines; Wake Lock; battery handled operationally |
| Projector visuals starve the server | Medium | Medium | Load test in Phase 3; WS-client design allows moving to a second machine |
| XSS via comment text on the projector | Medium | High | Escape on output everywhere; never `innerHTML`; server-side validation |
| Server crash mid-set | Low | High | Client autonomy (D17) reduces this to a minor event |
| Multi-channel multiplies bandwidth | Medium | Medium | Prefetch own channel only; buffered pause on switch |

---

## Part 5 — Remaining Open Questions

Most of the register is now settled. What's left:

1. **One DJ across all channels, or one DJ per channel?** The second needs per-channel auth scoping in the dashboard and raises a moderation question — with the DJ as sole moderator, whose dashboard do comments land in when there are several? Build the auth model to allow scoping now; decide the UI later.
2. **How many channels realistically?** Two changes little. Four multiplies DJ workload, bandwidth, and dashboard complexity substantially — and with a single moderator already running music, it compounds the attention problem.
3. **Does the projector need to work when the server is down?** D17 keeps phones playing through a crash. The projector is a WebSocket client, so it would freeze. Probably acceptable — worth a conscious decision.
4. **Library size, eventually.** Only affects whether the dashboard needs search. Safe to defer until Phase 3.
5. **Anything you'd want to reuse across venues?** Projector offset is stored per-venue. Are there other venue-scoped settings — AP channel, room layout, default moderation mode — worth a saved profile?

---

## Assumptions Still in Force

- Music is in headphones only; no speakers or live acoustic source in the room.
- The music library is yours and legally usable in this context. A genuinely private, non-ticketed party is generally outside public-performance licensing scope in Australia, New Zealand, the US, the UK and the EU, but "private" is narrower than most people assume. If the event becomes ticketed, publicly advertised or commercially hosted, get jurisdiction-specific advice — the US, UK and most EU states split composition and recording rights across separate societies requiring separate licences, while AU/NZ arrangements are more consolidated.
- Single room, single venue, one event at a time.
- No PII is collected anywhere in the system, including in comments.
- Battery is handled operationally and is out of scope for the build.
