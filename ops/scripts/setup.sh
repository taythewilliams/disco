#!/usr/bin/env bash
#
# Bootstrap a fresh MacBook (README "Setting up a second machine").
#
# Idempotent: safe to run against a machine that is already half set up, and it
# never overwrites anything that holds a secret or a measurement. What it will
# not do is the four things that cannot be automated safely —
#
#   1. Issue the certificate. That needs a TXT record in cPanel by hand.
#   2. Repoint the DNS A record at this machine's LAN address.
#   3. Copy or re-ingest the music library.
#   4. Choose the event code and DJ credential.
#
# — and it prints each of them at the end rather than pretending they are done.
#
#   ops/scripts/setup.sh

set -euo pipefail

cd "$(dirname "$0")/../.."

BREW_PACKAGES=(node ffmpeg aubio caddy certbot)
MIN_NODE_MAJOR=22

step() { printf '\n▸ %s\n' "$1"; }
ok() { printf '  ✓ %s\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; }

todo=()
note() { todo+=("$1"); }

# ── Tools ───────────────────────────────────────────────────────────────────

step "Checking Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  cat >&2 <<'MISSING'
  ✗ Homebrew is not installed. Install it first:

      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

MISSING
  exit 1
fi
ok "$(brew --version | head -1)"

step "Installing tools"
for pkg in "${BREW_PACKAGES[@]}"; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    ok "$pkg already installed"
  else
    echo "  … installing $pkg"
    brew install "$pkg"
  fi
done

# ffmpeg and aubio are hard dependencies of ingest, not optional extras: no
# transcode, no loudness, no beat grid, and the projector has nothing to draw
# with (D10).
for tool in ffmpeg ffprobe aubio caddy certbot; do
  command -v "$tool" >/dev/null 2>&1 && ok "$tool on PATH" || warn "$tool missing from PATH after install"
done

step "Checking Node"
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if ((node_major < MIN_NODE_MAJOR)); then
  warn "Node $node_major found, $MIN_NODE_MAJOR+ required (--env-file and the test runner both need it)"
  note "Install Node $MIN_NODE_MAJOR or newer, then re-run this script."
else
  ok "Node $(node -v)"
fi

# ── The repository ──────────────────────────────────────────────────────────

step "Installing dependencies"
if [[ -d node_modules ]]; then
  # `npm ci` deletes node_modules first, which would break a server running out
  # of this tree. On an already-populated checkout, install is the safe verb.
  npm install --silent
  ok "dependencies up to date"
else
  npm ci --silent
  ok "dependencies installed from the lockfile"
fi

# better-sqlite3 is the one native module. A prebuilt binary covers the usual
# case; when it does not, the build needs Xcode's command line tools, and the
# failure is a wall of node-gyp output that says nothing about the cause.
if node -e 'require("better-sqlite3")' >/dev/null 2>&1; then
  ok "better-sqlite3 loads"
else
  warn "better-sqlite3 failed to load — try: xcode-select --install, then npm rebuild"
  note "Fix better-sqlite3 before ingesting: it is the library manifest."
fi

step "Building the apps"
# The server serves these from disk. Without a build there is no PWA at the
# door and no dashboard for the DJ.
npm run build --silent >/dev/null
ok "guest PWA and dashboard built"

# ── Configuration ───────────────────────────────────────────────────────────

step "Configuring .env"
if [[ -f .env ]]; then
  ok ".env already exists — left untouched"
else
  # Secrets are generated rather than copied from the example, and are never
  # printed: they go straight into a gitignored file for you to read (D12).
  session_secret=$(openssl rand -hex 32)
  display_code=$(openssl rand -hex 12)
  sed \
    -e "s|^DISCO_SESSION_SECRET=.*|DISCO_SESSION_SECRET=${session_secret}|" \
    -e "s|^# DISCO_DISPLAY_CODE=.*|DISCO_DISPLAY_CODE=${display_code}|" \
    .env.example >.env
  chmod 600 .env
  ok ".env created with a generated session secret and display code"
  note "Edit .env: set DISCO_EVENT_CODE (goes on the poster) and DISCO_DJ_PASSWORD (a real secret)."
fi

step "Configuring Caddy"
if [[ -f ops/Caddyfile ]]; then
  ok "ops/Caddyfile already exists — left untouched"
elif [[ -z "${DISCO_PUBLIC_HOST:-}" ]]; then
  warn "set DISCO_PUBLIC_HOST and re-run to generate ops/Caddyfile"
  note "Copy ops/Caddyfile.example to ops/Caddyfile and set the hostname and certificate paths."
else
  sed \
    -e "s|party\.example\.com|${DISCO_PUBLIC_HOST}|g" \
    -e "s|/Users/you|${HOME}|g" \
    -e "s|^\temail you@example.com$||" \
    ops/Caddyfile.example >ops/Caddyfile
  ok "ops/Caddyfile written for ${DISCO_PUBLIC_HOST}"
fi

# ── What this machine still needs from a human ──────────────────────────────

lan_ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 'unknown')
host="${DISCO_PUBLIC_HOST:-party.example.com}"

if [[ ! -d media/tracks ]]; then
  note "No music library. Either copy media/ from the other machine (it also carries the venue profile and projector offset), or: npm run ingest -- ~/Music/folder --media \"\$PWD/media\""
fi

if [[ ! -d "$HOME/.disco-certs/config/live" ]]; then
  note "No certificate. Issue one: ops/scripts/renew-cert.sh $host you@example.com — or copy ~/.disco-certs from the other machine over a channel you trust (it contains the private key)."
fi

# Resolution is checked rather than assumed: a gateway with DNS rebinding
# protection strips private answers, and then this machine cannot find itself
# by name even though the record is perfectly correct (Spike 4).
resolved=$(dig +short A "$host" 2>/dev/null | tail -1)
if [[ "$resolved" != "$lan_ip" ]]; then
  note "$host resolves to '${resolved:-nothing}' here, not $lan_ip. Fix it with a hosts entry — the machine running the server should never depend on DNS to find itself: echo \"$lan_ip $host\" | sudo tee -a /etc/hosts"
fi

note "This machine is $lan_ip. The A record for $host points at ONE address — repoint it (and the AP's local DNS entry) or nothing resolves here."
note "macOS will prompt to allow incoming connections the first time Caddy binds 443. Allow it, or guests cannot connect."

step "Done"
if ((${#todo[@]})); then
  printf '\nStill to do, in this order:\n\n'
  n=1
  for item in "${todo[@]}"; do
    printf '  %d. %s\n\n' "$n" "$item"
    ((n++))
  done
fi

printf 'Then:  npm run up  ·  npm run status  ·  npm run preflight -- --host %s\n' "$host"
