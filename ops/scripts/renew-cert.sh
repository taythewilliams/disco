#!/usr/bin/env bash
#
# Issue or renew the venue certificate by hand (D14, Spike 4 option D).
#
# The zone lives in cPanel on shared hosting, whose DNS has no Caddy provider
# module, and it carries live mail — so the ACME challenge record is added by
# hand rather than by an API token. That makes renewal a step before every
# event rather than a cron job, which is exactly why `npm run cert-check` is on
# the pre-event checklist: an expired certificate at the door is the same
# failure as a self-signed one — no service worker, no PWA (D15).
#
#   ops/scripts/renew-cert.sh party.everyoneloves.pink you@example.com
#
# Everything lands under ~/.disco-certs, so this never needs sudo and the files
# stay readable by the user Caddy is started from.
#
# The flow is interactive on purpose: certbot prints a TXT value, waits, and you
# paste that value into cPanel's Zone Editor. Do not press Enter until the
# verification command below returns the value — validating early burns the
# attempt and certbot issues a fresh value on the next run.

set -euo pipefail

HOST="${1:-${DISCO_PUBLIC_HOST:-}}"
EMAIL="${2:-${DISCO_ACME_EMAIL:-}}"
CERT_ROOT="${DISCO_CERT_ROOT:-$HOME/.disco-certs}"

if [[ -z "$HOST" || -z "$EMAIL" ]]; then
  echo "usage: ops/scripts/renew-cert.sh <hostname> <email>" >&2
  echo "       or set DISCO_PUBLIC_HOST and DISCO_ACME_EMAIL" >&2
  exit 1
fi

if ! command -v certbot >/dev/null 2>&1; then
  echo "certbot is not installed:  brew install certbot" >&2
  exit 1
fi

# The zone's authoritative servers, asked directly. A public resolver may still
# be serving a cached negative answer while the record is already live, and
# waiting on that is the most common way this step goes wrong.
AUTHORITATIVE=$(dig +short NS "${HOST#*.}" | head -1)

cat <<BRIEF

Renewing:   $HOST
Files:      $CERT_ROOT/config/live/$HOST/
Zone:       ${HOST#*.}  (authoritative: ${AUTHORITATIVE:-unknown})

certbot will print a TXT record. Add it in cPanel:

  Zone Editor -> Manage (${HOST#*.}) -> Add Record -> TXT
    Name:  _acme-challenge.${HOST%%.*}
    TTL:   the lowest the panel allows
    Value: the string certbot prints

Then, BEFORE pressing Enter, confirm it is live:

  dig +short TXT _acme-challenge.$HOST @${AUTHORITATIVE:-dns1.namecheaphosting.com}
  dig +short TXT _acme-challenge.$HOST @1.1.1.1

BRIEF

mkdir -p "$CERT_ROOT"

certbot certonly \
  --manual \
  --preferred-challenges dns \
  --domain "$HOST" \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  --config-dir "$CERT_ROOT/config" \
  --work-dir "$CERT_ROOT/work" \
  --logs-dir "$CERT_ROOT/logs"

cat <<DONE

Certificate written to $CERT_ROOT/config/live/$HOST/

Next:
  1. Point ops/Caddyfile's tls line at fullchain.pem and privkey.pem there.
  2. sudo caddy run --config ops/Caddyfile
  3. npm run cert-check -- $HOST
  4. Delete the _acme-challenge TXT record in cPanel — it is spent, and a stale
     one is only confusing at the next renewal.
DONE
