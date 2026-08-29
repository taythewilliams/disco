# Spike 4 — HTTPS on the LAN

**Status: not yet run.** This file is the procedure and the place the results go
(BUILD.md Part D). Fill in the blanks as you go; a spike with no write-up is a
spike you will run again.

**Why it is the long pole.** Service workers, PWA install, Wake Lock and
persistent storage all require a secure context, and **a service worker will not
register on an origin with a certificate error even if the user clicks through**.
So no certificate means no Phase 2 arrival flow, no install, no offline shell —
and none of it can be tested on a real phone until this passes. DNS propagation
and provider-plugin quirks eat days, and none of it depends on the code (D14).

---

## Prerequisites

- [ ] Domain, with the zone moved to Cloudflare (registration stays wherever it is).
- [ ] A Cloudflare API token scoped to **Zone:DNS:Edit on that one zone**, in the
      environment as `CLOUDFLARE_API_TOKEN`. Never in source (D12).
- [ ] A Caddy build with the Cloudflare DNS module:
      `xcaddy build --with github.com/caddy-dns/cloudflare`, then
      `caddy list-modules | grep dns.providers.cloudflare`.
- [ ] The MacBook on a fixed LAN address. Before the access point arrives, a
      static address on the home network is enough to pass this spike.

---

## Step 0 — move the zone, and audit the records first

Cloudflare Free requires full nameserver delegation, so the **whole** zone moves.
Cloudflare's import scan catches most records but is not guaranteed complete.

**The failure mode here is email, not certificates.** If the domain carries mail
you depend on, a missed `MX`, `SPF`, `DKIM` or `DMARC` record breaks it quietly
and you will not notice for days.

- [ ] Export or screenshot the existing records at the registrar.
- [ ] Add the zone in Cloudflare; compare the imported records against that list.
- [ ] Change the nameservers. Cloudflare emails when the zone is active — usually
      well under an hour.

Records audited: _______________  Zone active at: _______________

## Step 1 — the A record

```
party.<domain>.   A   192.168.4.10
```

- [ ] **DNS-only. Grey cloud, never proxied.** A proxied record makes Cloudflare
      answer with their own anycast addresses, so guests resolve to a Cloudflare
      edge instead of the MacBook. It breaks silently and looks like a
      networking problem. `ops/scripts/preflight.mjs` calls this out by name if
      it sees Cloudflare addresses where the LAN address should be.

Pointing a public record at a private address is unusual but valid.

## Step 2 — Caddy

```bash
cp ops/Caddyfile.example ops/Caddyfile   # then set the hostname and email
CLOUDFLARE_API_TOKEN=… caddy run --config ops/Caddyfile
```

Iterate against Let's Encrypt **staging** first (the `acme_ca` line in the
example config): production rate limits are per registered domain per week, and
a handful of failed attempts will lock you out until the next one.

- [ ] First issuance succeeded.
- [ ] Switched back to production and reissued.

Issued at: _______________  Expires: _______________

## Step 3 — local DNS override on the access point

Deferred until the AP arrives; public DNS alone passes this spike.

Some resolvers implement **DNS rebinding protection** and refuse to return a
private address for a public hostname — which breaks things silently for the
guests using them. The AP answering authoritatively at the venue is the primary
path and public DNS is the fallback. **Do both** (D14 step 5).

- [ ] Static local DNS entry added on the AP.
- [ ] Verified from a phone on the venue Wi-Fi.

---

## Pass criteria

Run the server, then open `https://party.<domain>/selfcheck` on each phone. The
page is served by this repo (`packages/server/src/selfcheck.ts`) and checks
exactly what this spike asks, on the device that matters.

> The check must be run on **real phones**. An embedded or headless browser is
> not evidence: service workers are commonly unavailable in them, which reads as
> a failure of the certificate when it is a property of the browser.

| | iPhone | Android |
|---|---|---|
| Loads with **no** certificate warning | ☐ | ☐ |
| Service worker **registers** | ☐ | ☐ |
| Registration survives a reload | ☐ | ☐ |
| `navigator.storage.persist()` returns without throwing | ☐ | ☐ |
| Reported `AudioContext.outputLatency` | ______ ms | ______ ms |

Record the latency column even though it is not a pass criterion: Spike 3 uses
it to decide what calibration Layer 1 is worth, and phones are easiest to
measure while they are already in your hand (D1).

Then, from the MacBook:

```bash
node ops/scripts/cert-check.mjs party.<domain>
node --env-file=.env ops/scripts/preflight.mjs --host party.<domain> --ip 192.168.4.10
```

- [ ] `cert-check` reports a valid chain and the expiry date.
- [ ] `preflight` passes, or its warnings are understood.
- [ ] **Renewal proven at least once**: `caddy reload --config ops/Caddyfile`, or
      force a renewal, and confirm the expiry moved. Caddy renews only if it can
      reach the Cloudflare API, which needs the uplink — verify it rather than
      trusting it. An expired certificate at the door is the same failure as a
      self-signed one (D14 step 6).

---

## Results

_Fill in after the run: provider, token scope, the exact Caddyfile that worked,
what broke, and how long propagation actually took._

### What broke

### Time taken

### Decisions this changes
