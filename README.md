# Disco

An installed PWA that plays owned music in sync across 30+ phones on a local
network. Headphones only, no speakers. A DJ queues tracks from a dashboard, a
projector shows beat-synced visuals and a moderated comment feed, and everything
is served from one MacBook on site.

- **[docs/synced-audio-plan-v4.md](docs/synced-audio-plan-v4.md)** — the decision
  register. What and why. References like `D7` throughout the code point here.
- **[BUILD.md](BUILD.md)** — the build plan. Repo shape, protocol contract,
  ordered work, pass criteria.
- **[docs/](docs/)** — spike results and load tests, one file each.

---

## Setting up a machine

```bash
git clone <repo> disco && cd disco
DISCO_PUBLIC_HOST=party.example.com ops/scripts/setup.sh
```

The script installs Homebrew packages (`node ffmpeg aubio caddy certbot`),
installs dependencies, builds both apps, and writes `.env` and `ops/Caddyfile`
if they are missing. It is idempotent and never overwrites a file that holds a
secret or a measurement. It then prints what it could not do for you.

### The four things that are not in the repository

Everything below is deliberately absent — either secret, large, or specific to
one machine. A fresh clone needs all four before it can run an event.

| | Where it lives | How to get it on a new machine |
|---|---|---|
| **Secrets** | `.env` (gitignored) | `setup.sh` generates the session secret and display code. **You** choose `DISCO_EVENT_CODE` (goes on the poster) and `DISCO_DJ_PASSWORD` (a real secret). |
| **The music library** | `media/` (gitignored) | Copy `media/` wholesale from the other machine, or re-run ingest over the source audio. Copying also brings the **venue profile** — the projector offset measured in that room, which nobody should have to measure twice (D8). |
| **The certificate** | `~/.disco-certs/` | Issue a new one (`ops/scripts/renew-cert.sh`, ~5 minutes, one DNS record) or copy the directory over a channel you trust — **it contains the private key**. |
| **Caddy config** | `ops/Caddyfile` (gitignored) | `setup.sh` generates it from the example when `DISCO_PUBLIC_HOST` is set. It holds absolute certificate paths, so it is machine-specific. |

### The complication a script cannot fix

**The DNS A record points at one machine's LAN address.** Move to a different
MacBook and `party.example.com` still resolves to the old one. Before anything
works you must repoint the record in cPanel — and, at a venue, the access
point's local DNS entry as well.

Two more, both one-time:

- **macOS will prompt to allow incoming connections** the first time Caddy binds
  443. Deny it and guests get nothing while everything looks healthy locally.
- **The machine should not depend on DNS to find itself.** Add a hosts entry:
  `echo "192.168.1.x party.example.com" | sudo tee -a /etc/hosts`. This matters
  more than it sounds — see the rebinding note below.

---

## Running it

```bash
npm run up        # start Caddy (sudo, port 443) and the app (port 3000)
npm run status    # app · caddy · DNS · certificate expiry, in four lines
npm run down      # stop both
```

`ops/scripts/disco.sh logs` follows the app log; `ops/scripts/disco.sh restart`
does the obvious thing. The app writes to `ops/logs/` (gitignored).

### Everything else

| Command | What it does |
|---|---|
| `npm run ingest -- ~/Music/folder --media "$PWD/media"` | Transcode, loudness, beat grid, artwork → the manifest (D10) |
| `npm run preflight -- --host <host> --ip <lan-ip>` | Pre-event checks: secrets, DNS, certificate, library, builds, uplink |
| `npm run cert-check -- <host>` | Certificate expiry and chain, exit code gated on days remaining |
| `ops/scripts/renew-cert.sh <host> <email>` | Issue or renew by hand — **required before every event** |
| `npm run harness -- --clients 30 --seconds 60` | 30 virtual guests against a running server |
| `npm test` · `npm run typecheck` · `npm run build` | The usual |

### The URLs

| | Path | Credential |
|---|---|---|
| Guest PWA | `/` | `DISCO_EVENT_CODE` |
| DJ dashboard | `/dj` | `DISCO_DJ_PASSWORD` |
| Projector | `/display` | `DISCO_DISPLAY_CODE`, or the DJ credential |
| Device self-check | `/selfcheck` | none — it exists to debug the ones above |

**One browser holds one session per origin.** Signing in as a guest on the DJ's
laptop replaces the DJ session. Use phones for guests; the projector accepts the
DJ credential so both windows can share one session on one machine.

---

## How it fits together

```
Caddy :443 ──TLS──▶ Node :3000 ──▶ SQLite manifest + media/tracks
                          │
                          ├─ /            guest PWA          (apps/guest)
                          ├─ /dj          dashboard          (apps/host)
                          ├─ /display     projector          (apps/host)
                          └─ /ws          clock sync, state, comments
```

- **Caddy** owns 443 and the certificate. Restarting the app does not need it
  restarted.
- **The app** runs as a normal user on a high port and never handles TLS (D12).
- **Ingest** is offline and idempotent, keyed on file content hashes.
- **The venue profile** (`media/venue-<name>.json`) keeps the projector offset,
  prefetch depth, moderation mode and saved crates across restarts.

The certificate is issued **manually** via a DNS-01 challenge, because the zone
lives in cPanel with live mail on it and moving it to an API-driven provider
would put that mail in the path of a party. The trade is that **nothing renews
on its own** — `renew-cert.sh` before every event, `cert-check` to confirm. See
[docs/spikes/04-https-lan.md](docs/spikes/04-https-lan.md).

---

## When something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| **502** in the browser | Caddy is up, the app is down | `npm run status`, then `npm run up` |
| **Cannot resolve / connection refused** | DNS, or Caddy is down | `npm run status` distinguishes them |
| **`DNS_PROBE_FINISHED_BAD_CONFIG` on a phone** | The router strips private-address answers (DNS rebinding protection) — measured on real hardware, see Spike 4 | Point the device at `9.9.9.9`, and at a venue make the **AP** serve DNS with a local entry |
| **`/dj` shows the guest join screen** | A stale service worker from before the navigation denylist was fixed | Hard reload, or unregister the worker in DevTools |
| **Guests get 401 on audio** | No session — `/media` is gated by the event code, not just the timeline | They need to join through `/` first |
| **A phone will not install the PWA** | Certificate. A service worker refuses to register on an origin with a certificate error, even after clicking through | `npm run cert-check`, then `/selfcheck` on the phone |
| **Everything works on the laptop, nothing on phones** | macOS firewall blocking Caddy, or DNS | Allow incoming connections; check `/selfcheck` from the phone |

`/selfcheck` on a phone answers most of these directly: secure context, service
worker registration, persistent storage, Wake Lock, and the device's reported
`AudioContext.outputLatency` — which is also a Spike 3 input worth collecting
from every phone that passes through.
