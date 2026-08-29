#!/usr/bin/env bash
#
# Start, stop and inspect the whole system (Phase 4's runbook).
#
# Two processes, and they fail in ways that look alike from a browser:
#
#   Caddy  — owns 443, terminates TLS, proxies to the app. Needs sudo, because
#            443 is privileged on macOS. Holds the certificate.
#   App    — Node on 3000, non-root. The thing that actually plays music.
#
# A 502 in a browser means Caddy is up and the app is down. "Cannot connect"
# means Caddy is down, or DNS is. `status` below answers both at once, which is
# the whole reason this exists: at 11pm you want one command, not a diagnosis.
#
#   ops/scripts/disco.sh up       start both
#   ops/scripts/disco.sh down     stop both
#   ops/scripts/disco.sh status   what is running, and is it healthy
#   ops/scripts/disco.sh logs     follow the app log
#   ops/scripts/disco.sh restart  down, then up

set -euo pipefail

cd "$(dirname "$0")/../.."

LOG_DIR="ops/logs"
APP_LOG="$LOG_DIR/app.log"
CADDY_LOG="$LOG_DIR/caddy.log"
APP_MATCH="packages/server/src/main.ts"
HEALTH="http://127.0.0.1:3000/api/health"

app_running() { pgrep -f "$APP_MATCH" >/dev/null 2>&1; }
caddy_running() { pgrep -x caddy >/dev/null 2>&1; }

start_app() {
  if app_running; then
    echo "app     already running"
    return
  fi
  mkdir -p "$LOG_DIR"
  # Backgrounded and logged rather than inherited from this shell, so closing
  # the terminal does not take the music down mid-set.
  nohup node --env-file=.env --import tsx packages/server/src/main.ts >>"$APP_LOG" 2>&1 &
  for _ in $(seq 1 40); do
    if curl -fsS -m 1 "$HEALTH" >/dev/null 2>&1; then
      echo "app     started        ($APP_LOG)"
      return
    fi
    sleep 0.25
  done
  echo "app     FAILED TO START — last lines of $APP_LOG:" >&2
  tail -5 "$APP_LOG" >&2
  return 1
}

start_caddy() {
  if caddy_running; then
    echo "caddy   already running"
    return
  fi
  if [[ ! -f ops/Caddyfile ]]; then
    echo "caddy   no ops/Caddyfile — copy ops/Caddyfile.example and set the hostname" >&2
    return 1
  fi
  mkdir -p "$LOG_DIR"
  # sudo prompts here if the timestamp has expired. That is the one moment this
  # script is interactive, and it is better than discovering it at the door.
  sudo caddy run --config ops/Caddyfile >>"$CADDY_LOG" 2>&1 &
  sleep 2
  caddy_running && echo "caddy   started        ($CADDY_LOG)" || {
    echo "caddy   FAILED TO START — last lines of $CADDY_LOG:" >&2
    tail -5 "$CADDY_LOG" >&2
    return 1
  }
}

stop_app() {
  if app_running; then
    # SIGTERM, not SIGKILL: the app flushes the venue profile and clears the
    # comment feed on the way out, and both of those matter (D7, D8).
    pkill -f "$APP_MATCH" || true
    echo "app     stopped"
  else
    echo "app     not running"
  fi
}

stop_caddy() {
  if caddy_running; then
    sudo pkill -x caddy || true
    echo "caddy   stopped"
  else
    echo "caddy   not running"
  fi
}

status() {
  # Read the hostname from .env when the shell does not carry it. Only that one
  # key is parsed rather than sourcing the file: .env holds the DJ credential
  # and the session secret, and neither belongs in this shell's environment.
  local host="${DISCO_PUBLIC_HOST:-}"
  if [[ -z "$host" && -f .env ]]; then
    host=$(grep -E '^DISCO_PUBLIC_HOST=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')
  fi

  if app_running; then
    local health
    health=$(curl -fsS -m 2 "$HEALTH" 2>/dev/null || echo '')
    if [[ -n "$health" ]]; then
      echo "app     up             $health"
    else
      echo "app     RUNNING BUT NOT ANSWERING — check $APP_LOG"
    fi
  else
    echo "app     down"
  fi

  caddy_running && echo "caddy   up" || echo "caddy   down"

  if [[ -n "$host" ]]; then
    # Resolution is checked separately from reachability: a gateway that strips
    # private answers (DNS rebinding protection) looks exactly like the server
    # being down, and it is not (D14 step 5).
    local resolved
    resolved=$(dig +short A "$host" | tail -1)
    if [[ -n "$resolved" ]]; then
      echo "dns     $host -> $resolved"
    else
      echo "dns     $host DOES NOT RESOLVE HERE — gateway stripping the private answer?"
    fi
    node ops/scripts/cert-check.mjs "$host" 2>/dev/null | tail -1 | sed 's/^/cert    /'
  else
    echo "dns     set DISCO_PUBLIC_HOST to check the hostname and certificate"
  fi
}

case "${1:-status}" in
up)
  start_app
  start_caddy
  ;;
down)
  stop_app
  stop_caddy
  ;;
restart)
  stop_app
  stop_caddy
  sleep 1
  start_app
  start_caddy
  ;;
status) status ;;
logs) tail -f "$APP_LOG" ;;
*)
  echo "usage: ops/scripts/disco.sh [up|down|restart|status|logs]" >&2
  exit 1
  ;;
esac
