# Spike 4 — HTTPS on the LAN

**Status: PASSED, 2026-08-29.** A real certificate, on the real hostname, with a
service worker registering on both an iPhone and an Android. Procedure below;
results and the two things it changed at the bottom.

**Why it is the long pole.** Service workers, PWA install, Wake Lock and
persistent storage all require a secure context, and **a service worker will not
register on an origin with a certificate error even if the user clicks through**.
No certificate means no Phase 2 arrival flow, no install, no offline shell — and
none of it can be tested on a real phone until this passes (D14).

---

## What the zone actually looks like

Checked 2026-08-29, before changing anything:

| | |
|---|---|
| Domain | `everyoneloves.pink`, hostname `party.everyoneloves.pink` |
| Nameservers | `dns1.namecheaphosting.com`, `dns2.namecheaphosting.com` — Namecheap shared hosting, managed through cPanel |
| Apex A | `199.188.200.110` |
| `party` A | **already exists**, `199.188.200.110`. No wildcard — someone created it explicitly, so this is a repoint rather than a new record |
| Mail | **Live.** `MX` → `mx1/2/3-hosting.jellyfish.systems`, SPF `v=spf1 +a +mx +ip4:… include:spf.web-hosting.com ~all` |
| MacBook | `192.168.12.131`, gateway `192.168.12.1` (the plan's `192.168.4.10` is not this network) |

## The decision this changed

BUILD.md Part A picked Cloudflare for the zone so that Caddy could solve DNS-01
through an API. That assumed the zone was worth moving. It is not:

- The zone carries live mail. Moving it puts `MX`, SPF and DKIM in the path of a
  party, and the failure mode is silent for days.
- cPanel's DNS has **no Caddy provider module** — the [caddy-dns
  organisation](https://github.com/caddy-dns) has ~99 providers and none for
  cPanel or WHM — so keeping the zone where it is rules out automation anyway.

**Chosen: manual DNS-01 (option D).** The TXT record is added by hand in cPanel
and Caddy is handed the resulting files. Nothing about the existing zone moves.

The cost is real and accepted: **renewal is a manual step before every event.**
That is why `npm run cert-check` and `npm run preflight` exist and why they are
on the pre-event checklist rather than being niceties.

Rejected, and why:

- **Move the zone to Cloudflare** — automation, but the blast radius is the
  domain's email.
- **Delegate `party.` to deSEC via two NS records** — automation with almost no
  blast radius, and the right answer if manual renewal becomes annoying. Kept as
  the upgrade path; it needs cPanel's Zone Editor to allow `NS` records.
- **acme-dns CNAME** — one record, automated, but a third party in the
  certificate path.

---

## Procedure

### 1. Tools

```bash
brew install certbot caddy
```

Stock Caddy is fine here — no DNS provider module is needed, because Caddy never
talks to the DNS API in this design.

### 2. Issue the certificate

```bash
ops/scripts/renew-cert.sh party.everyoneloves.pink you@example.com
```

Certbot prints a TXT value and waits. In cPanel → **Domains → Zone Editor** →
**Manage** on `everyoneloves.pink` → **Add Record**:

- Type `TXT`
- Name `_acme-challenge.party` (cPanel appends the domain)
- TTL: the lowest the panel allows
- Value: the string certbot printed, exactly

**Do not press Enter yet.** Confirm the record is live first — validating early
burns the attempt and the next run issues a different value:

```bash
dig +short TXT _acme-challenge.party.everyoneloves.pink @dns1.namecheaphosting.com
```

```bash
dig +short TXT _acme-challenge.party.everyoneloves.pink @1.1.1.1
```

The first is authoritative and answers as soon as the record is saved. The
second is the one Let's Encrypt's resolvers behave like.

Files land in `~/.disco-certs/config/live/party.everyoneloves.pink/`. Delete the
`_acme-challenge` record afterwards; it is spent.

### 3. Caddy

```bash
cp ops/Caddyfile.example ops/Caddyfile
```

Set the hostname and the two absolute certificate paths, then:

```bash
sudo caddy run --config ops/Caddyfile
```

`sudo` because 443 is privileged on macOS. Only Caddy runs elevated — the Node
app stays a normal user on a high port, which is what D12 asks for.

### 4. Repoint the A record

The certificate does **not** depend on this: DNS-01 reads only the TXT record,
so issuance can happen before the hostname points anywhere useful.

In cPanel → Zone Editor, edit the existing `party` A record from
`199.188.200.110` to the MacBook's LAN address. Lower its TTL first if you want
the change to propagate in minutes rather than an hour.

Two consequences to expect:

- Anything currently served at `party.everyoneloves.pink` by the shared host
  stops working. Check there is nothing there first.
- Some resolvers implement **DNS rebinding protection** and refuse to return a
  private address for a public hostname, which breaks silently for whichever
  guests use one. The access point's local DNS entry is the primary path and
  public DNS the fallback — do both (D14 step 5).

### 5. Reserve the address

`192.168.12.131` is a DHCP lease and will move. Reserve it on the router now,
and again on the venue AP when it arrives; the A record has to match.

---

## Pass criteria

Open `https://party.everyoneloves.pink/selfcheck` on each phone. The page is
served by this repo (`packages/server/src/selfcheck.ts`) and checks exactly what
this spike asks, on the device that matters.

> Run it on **real phones**. An embedded or headless browser is not evidence:
> service workers are commonly unavailable in them, which reads as a failed
> certificate when it is a property of the browser.

| | iPhone (Safari) | Android |
|---|---|---|
| Loads with **no** certificate warning | ✅ | ✅ |
| Service worker **registers** | ✅ scope `/selfcheck` | ✅ |
| Registration survives a reload | ✅ | ✅ |
| `navigator.storage.persist()` returns without throwing | ✅ declined, 41 GB quota | ✅ |
| Reported `AudioContext.outputLatency` | **13 ms** (base 3 ms, 48 kHz) | ______ ms |
| Wake Lock available | ✅ | ______ |

**Wake Lock is available on iOS Safari**, which is what D16's layered mitigation
assumed but had not been confirmed on a real device.

### Installing changes two answers on iOS

The same page, run again from the home-screen app rather than a Safari tab:

| | Safari tab | Installed PWA |
|---|---|---|
| `storage.persist()` | **declined**, 41 GB quota | **granted** |
| `AudioContext.outputLatency` | 13 ms @ 48 kHz | **203 ms @ 44.1 kHz** |
| Display mode | browser tab | installed |

**Persistence flips to granted on install.** D15 treated `persist()` as a bonus
that may be declined — true in a tab, and apparently not true once installed.
That is another reason the arrival flow pushes install rather than merely
offering it (D4), and it is worth stating in the guest copy.

**The latency reading moved with the audio route, not with the container** —
confirmed: the 203 ms reading was taken with Sony Bluetooth headphones
connected, the 13 ms one on the built-in output. The sample rate moving 48 kHz →
44.1 kHz alongside it is the A2DP tell.

### What that means for calibration (D1) — a Spike 3 input

**iOS Safari's `outputLatency` tracks the output route.** D1 assumed "Android
Chrome reports a value partially reflecting the real audio path; Safari is
unreliable" and treated Layer 1 as a hint that mostly would not fire on iPhones.
On this device it fired, and it moved by 190 ms in the right direction when the
route changed.

If that holds across a few more devices, Layer 1 is doing most of the work on
iOS before a guest touches the slider, and the human refinement (Layer 3) is
correcting tens of milliseconds rather than hundreds. That is the difference
between calibration being a load-bearing step and a polish step.

**It also corroborates the preset table.** `DEFAULT_RUNTIME_CONFIG.devicePresetMs`
carries `bluetooth: 200`, measured 203 on Sony over A2DP — close enough to leave
alone. One device is not a re-tuning, which is exactly why that table is
server-driven and correctable mid-event (D11).

Worth gathering the same two numbers from every phone that passes through Spike
3: it is one tap on `/selfcheck` and it is the cheapest evidence available for
the term that dominates the whole error budget.

Record the latency column even though it is not a pass criterion: Spike 3 uses
it to decide what calibration Layer 1 is worth, and phones are easiest to
measure while they are already in your hand (D1).

From the MacBook:

```bash
npm run cert-check -- party.everyoneloves.pink
```

```bash
npm run preflight -- --host party.everyoneloves.pink --ip 192.168.12.131
```

- [ ] `cert-check` reports a valid chain and the expiry date.
- [ ] `preflight` passes, or its warnings are understood.
- [ ] **Renewal proven at least once** — run `renew-cert.sh` a second time and
      confirm the expiry moved. Proving it once now is what stops it being
      discovered at the door in 90 days.

---

## Results

### Issued

**2026-08-29.** Let's Encrypt, `CN=party.everyoneloves.pink`, via manual DNS-01
with the TXT record added in cPanel. Valid 29 Aug → **27 Nov 2026**. One
attempt.

Files: `~/.disco-certs/config/live/party.everyoneloves.pink/`.

### Verified through Caddy, before touching DNS

Forcing the hostname to resolve locally (`curl --resolve …:443:127.0.0.1`)
proved the whole chain without repointing anything — the cheapest possible
order, since nothing is changed until it is known to work:

| | |
|---|---|
| Chain validates | yes (`ssl_verify_result=0`), HTTP/2 |
| Headers | CSP, HSTS, `nosniff`, `no-referrer`, Permissions-Policy present; `Server` stripped |
| Routes | `/`, `/selfcheck`, `/selfcheck.js`, `/dj`, `/display`, `/api/health` all 200 |
| Media without a session | 401 |
| Session exchange | cookie issued over TLS |
| **WebSocket upgrade** | `hello role=guest protocol=v2`, ping → pong **1.0 ms** |

The WebSocket is the one a reverse proxy quietly breaks — a mangled upgrade or
an idle-socket timeout would take clock sync down mid-set. It survives
`reverse_proxy` with `read_timeout`/`write_timeout` at 0.

### Still to do

- [ ] Repoint the `party` A record from `199.188.200.110` to the MacBook.
      Nothing of value is served there now — it is an empty cPanel autoindex.
- [ ] Reserve the MacBook's address on the router; `192.168.12.131` is a lease.
- [ ] Run `/selfcheck` on a real iPhone and a real Android. **This is the actual
      pass criterion** and nothing so far substitutes for it: service-worker
      registration is the thing a certificate error breaks, and it can only be
      observed on a real browser.
- [ ] Remove `DISCO_INSECURE_COOKIES=1` from `.env` now that there is real TLS.
- [ ] Local DNS entry on the access point, when it arrives (D14 step 5).

### What broke

Two stumbles, both worth keeping:

1. **`ops/Caddyfile` was run unedited**, so Caddy looked for
   `/Users/you/…/party.example.com/fullchain.pem`. The example file now carries
   the placeholder paths conspicuously enough to notice.
2. **`sudo caddy run` created a root-owned `ops/caddy-data/`**, after which
   every non-root `caddy validate` failed on the access log inside it. Caddy now
   logs to stdout instead of into the working tree.

3. **The PWA's service worker swallowed `/selfcheck`.** On an iPhone that had
   already loaded the guest app, the diagnostic page returned the guest join
   screen: workbox's `navigateFallback` serves the cached shell for any path not
   on the denylist, and the list only covered `/api/`, `/media/` and `/ws`. The
   page that exists to diagnose the app was being answered by the app.

   Fixed in `apps/guest/vite.config.ts` by denylisting `/selfcheck`, `/dj`,
   `/display` and `/host/` as well. The last three matter beyond this spike: the
   DJ's laptop and the projector machine are the devices most likely to have
   loaded the guest app while testing, and either would have got the guest shell
   instead of its own screen. This is a bug the venue would have found for us.

### DNS rebinding protection is real, and it is in the room

Measured 2026-08-29 on the home network. The public path is clean — the
authoritative servers, `1.1.1.1`, `8.8.8.8` and `9.9.9.9` all return
`192.168.12.131` for `party.everyoneloves.pink` without complaint. **The local
router is the one that refuses.**

```
dig party.everyoneloves.pink A @192.168.12.1
;; ->>HEADER<<- status: NOERROR ... ANSWER: 0
```

`NOERROR` with no answer is the signature: the gateway resolves the name, sees a
private address in the reply, and strips it. Chrome on Android reports this as
`DNS_PROBE_FINISHED_BAD_CONFIG`. An iPhone that still held a cached answer kept
working, which is exactly the kind of split behaviour that makes this hard to
diagnose at 11pm.

The gateway here is a **T-Mobile Gateway** (`192.168.12.1`, hence the unusual
subnet). It exposes no local-DNS entry and no rebinding-protection toggle, so on
this network there is nothing to configure.

**Consequences for the venue (D13, D14 step 5):**

- **The access point must serve DHCP and DNS to guests**, with a static local
  entry for the hostname. The uplink router — whatever the venue has — is
  upstream only and must not be the resolver guests are handed. This promotes
  D14's "do both" from prudence to a requirement: the public A record alone will
  not work behind a gateway like this one.
- **If the AP cannot do local DNS**, the fallback is `dnsmasq` on the MacBook
  answering for the one hostname, advertised as the DNS server over DHCP.
- Per-device DNS (pointing a phone at `9.9.9.9`) works and is fine for testing
  two phones. It is not a venue plan: nobody is configuring resolvers for thirty
  guests at the door.

### Decisions this changes

BUILD.md Part A's "DNS: Cloudflare for the zone" is superseded for this domain —
see the decision note above. The upgrade path if manual renewal becomes
annoying is delegating `party.` to deSEC, not moving the zone.
