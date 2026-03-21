#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Start NemoClaw auxiliary services: Slack bridge.
#
# Usage:
#   SLACK_BOT_TOKEN=... SLACK_APP_TOKEN=... ./scripts/start-services.sh
#   ./scripts/start-services.sh --status
#   ./scripts/start-services.sh --stop
#   ./scripts/start-services.sh --sandbox mybox
#   ./scripts/start-services.sh --sandbox mybox --stop
#
# Optional env:
#   ALLOWED_USERS     — comma-separated Slack user IDs to accept (default: all)
#   ALLOWED_CHANNELS  — comma-separated Slack channel IDs to accept (default: all)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source .env if present (tokens, access control, sandbox name)
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$REPO_DIR/.env"
  set +a
fi

# ── Parse flags ──────────────────────────────────────────────────
SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"
ACTION="start"

while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox)
      SANDBOX_NAME="${2:?--sandbox requires a name}"
      shift 2
      ;;
    --stop)
      ACTION="stop"
      shift
      ;;
    --status)
      ACTION="status"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

PIDDIR="/tmp/nemoclaw-services-${SANDBOX_NAME}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[services]${NC} $1"; }
warn()  { echo -e "${YELLOW}[services]${NC} $1"; }
fail()  { echo -e "${RED}[services]${NC} $1"; exit 1; }

is_running() {
  local pidfile="$PIDDIR/$1.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    return 0
  fi
  return 1
}

start_service() {
  local name="$1"
  shift
  if is_running "$name"; then
    info "$name already running (PID $(cat "$PIDDIR/$name.pid"))"
    return 0
  fi
  nohup "$@" > "$PIDDIR/$name.log" 2>&1 &
  echo $! > "$PIDDIR/$name.pid"
  info "$name started (PID $!)"
}

stop_service() {
  local name="$1"
  local pidfile="$PIDDIR/$name.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
      info "$name stopped (PID $pid)"
    else
      info "$name was not running"
    fi
    rm -f "$pidfile"
  else
    info "$name was not running"
  fi
}

show_status() {
  mkdir -p "$PIDDIR"
  echo ""
  for svc in slack-bridge; do
    if is_running "$svc"; then
      echo -e "  ${GREEN}●${NC} $svc  (PID $(cat "$PIDDIR/$svc.pid"))"
    else
      echo -e "  ${RED}●${NC} $svc  (stopped)"
    fi
  done
  echo ""
}

do_stop() {
  mkdir -p "$PIDDIR"
  stop_service slack-bridge
  info "All services stopped."
}

do_start() {
  [ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY required"

  if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SLACK_APP_TOKEN:-}" ]; then
    warn "SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set — Slack bridge will not start."
    warn "Create a Slack app at https://api.slack.com/apps with Socket Mode enabled."
  fi

  command -v node > /dev/null || fail "node not found. Install Node.js first."

  # Verify sandbox is running
  if command -v openshell > /dev/null 2>&1; then
    if ! openshell sandbox list 2>&1 | grep -q "Ready"; then
      warn "No sandbox in Ready state. Slack bridge may not work until sandbox is running."
    fi
  fi

  mkdir -p "$PIDDIR"

  # Slack bridge (only if both tokens provided)
  if [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_APP_TOKEN:-}" ]; then
    # Use multi-user bridge if users.json exists with registered users
    USERS_FILE="$HOME/.nemoclaw/users.json"
    if [ -f "$USERS_FILE" ] && python3 -c "import json; d=json.load(open('$USERS_FILE')); exit(0 if len(d.get('users',{})) > 0 else 1)" 2>/dev/null; then
      start_service slack-bridge \
        node "$REPO_DIR/scripts/slack-bridge-multi.js"
    else
      SANDBOX_NAME="$SANDBOX_NAME" ALLOWED_USERS="${ALLOWED_USERS:-}" start_service slack-bridge \
        node "$REPO_DIR/scripts/slack-bridge.js"
    fi
  fi

  # Print banner
  echo ""
  echo "  ┌─────────────────────────────────────────────────────┐"
  echo "  │  NemoClaw Services                                  │"
  echo "  │                                                     │"

  if is_running slack-bridge; then
    echo "  │  Slack:       bridge running                        │"
  else
    echo "  │  Slack:       not started (no token)                │"
  fi

  echo "  │                                                     │"
  echo "  │  Run 'openshell term' to monitor egress approvals   │"
  echo "  └─────────────────────────────────────────────────────┘"
  echo ""
}

# Dispatch
case "$ACTION" in
  stop)   do_stop ;;
  status) show_status ;;
  start)  do_start ;;
esac
