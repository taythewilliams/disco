# Engine comparison 01 — Web Audio vs media element

Measured 2026-08-29 on the development MacBook, one guest at a time, against a
real server and real ingested tracks. Drift readings are the guest's own
telemetry as the dashboard sees it: `element/graph position − room position`,
negative meaning the guest is behind the room.

**This is one browser on one machine.** D2 says the decision to drop an engine
should be made on telemetry from a real floor; this is the first data point, not
that decision.

## Results

| | `WebAudioEngine` | `MediaElementEngine` |
|---|---|---|
| Steady-state drift | **+0.22 ms** | −47 ms → **−0.84 ms** after tuning |
| Predicted by D2 | 5–10 ms | 30–50 ms |
| Survives backgrounding | No — iOS suspends the context | Yes, plus lock-screen controls |
| Memory | ~35 MB per resident segment (Float32) | Encoded fragments only |
| MSE required | No | Yes — iOS 17.1+ on iPhone |

Web Audio lands an order of magnitude better than the budget allows for
scheduling precision. The media element does not, until corrected.

## What the media element actually does

Seeking and then starting playback is not instantaneous. The element resumes
*behind* the seek target by its own resume cost, so seeking to the room's
position leaves the guest permanently behind by that much.

**Seeking again cannot fix it**, because the offset *is* the cost of the seek —
the correction re-creates exactly the error it is trying to remove. This was
visible as a drift pinned at −47 ms that never moved:

```
t+08s  drift= -47.26 ms
t+16s  drift= -47.50 ms
t+24s  drift= -47.59 ms
t+32s  drift= -47.88 ms
```

Nor can the fine correction absorb it. At −47 ms it sits under the 60 ms coarse
threshold, so `playbackRate` steering owns it — and at the ±0.1 % clamp that
takes about three minutes. Tracks are shorter than that, and **every track
boundary re-creates the offset**, so left alone it never converges at all.

## The fix: aim ahead

`mediaElementSeekBiasMs` (D11, remote-configurable) is how far ahead of the room
a seek aims, so the element lands *on* it. Tuned live from the dashboard while
the room was playing:

| Bias | Steady-state drift |
|---|---|
| 0 ms | −47 ms |
| 47 ms | −20 ms |
| 67 ms | **−0.84 ms** |

The residual is not linear in the bias, so this is an **empirical constant per
device and browser, not a derived one**. The default is now 67 ms because that
is what measured clean here. Re-measure at the venue from the telemetry panel
and correct it live — the whole point of it being remote config is that nobody
should be editing source at 11pm.

The change took effect at the next track boundary, roughly 60 seconds after the
`config.set`, because the bias is applied when a track is scheduled.

## The finding that matters for D2

**A room split across both engines gets a bimodal spread, not a shared delay.**

Per v4 Part 0 a uniform delay is inaudible — so a floor entirely on media
elements, all 47 ms late together, would look perfectly in time. The problem is
a mixed room: Web Audio guests at 0 ms and media-element guests at −47 ms are
47 ms apart, which is right at the edge of where asynchrony shows up in dancing.

Two consequences:

1. **Prefer forcing one engine room-wide** over letting capability detection
   split the floor. `engineOverride` already does this and was verified working:
   a `config.set` rebuilt the engine on a live client mid-set, without a reload.
2. If the room must be mixed — an older iPhone with no MSE cannot run the media
   element at all — then `mediaElementSeekBiasMs` is what keeps the two groups
   together, and it has to be right.

## What this does not tell you

- **Nothing about iOS.** Both the backgrounding behaviour that motivates the
  media element (D16) and the MSE availability floor (iOS 17.1) are untested
  here. That is Spike 1.
- **Nothing about real headphones.** Drift is measured against the room's
  timeline, not against a guest's ear. Output latency is calibration's job, and
  its variance is what Spike 3 measures.
- **Nothing about a busy access point.** Segment arrival was near-instant over
  loopback; a media element starved of appended data behaves differently from
  one that is not.

## Reproducing

```bash
npm run dev --workspace @disco/guest
```

Force an engine and tune the bias from the dashboard, or by hand:

```bash
# {"t":"config.set","patch":{"engineOverride":"mediaelement"}}
# {"t":"config.set","patch":{"mediaElementSeekBiasMs":67}}
```

Read the result from `GET /api/telemetry`, or the dashboard's client panel.
