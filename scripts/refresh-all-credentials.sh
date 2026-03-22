#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Refresh credentials for all registered users.
# Falls back to single-sandbox refresh if no users.json exists.
#
# Usage: ./scripts/refresh-all-credentials.sh

set -uo pipefail
# Note: -e intentionally omitted — one sandbox failure must not abort the loop.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$REPO_DIR/.env" ]; then
  set -a; . "$REPO_DIR/.env"; set +a
fi

USERS_FILE="$HOME/.nemoclaw/users.json"

if [ -f "$USERS_FILE" ] && python3 -c "import json; d=json.load(open('$USERS_FILE')); exit(0 if len(d.get('users',{})) > 0 else 1)" 2>/dev/null; then
  # Multi-user mode: iterate over all enabled users
  USER_IDS=$(python3 -c "import json; d=json.load(open('$USERS_FILE')); [print(uid) for uid, u in d.get('users',{}).items() if u.get('enabled', True)]")

  for uid in $USER_IDS; do
    SANDBOX=$(python3 -c "import json; print(json.load(open('$USERS_FILE'))['users']['$uid']['sandboxName'])")
    CRED_DIR=$(python3 -c "import json; print(json.load(open('$USERS_FILE'))['users']['$uid'].get('credentialsDir',''))")
    NAME=$(python3 -c "import json; print(json.load(open('$USERS_FILE'))['users']['$uid'].get('slackDisplayName','$uid'))")

    # Sync host Claude OAuth token to per-user cred dir (keeps persist copy fresh)
    if [ -n "$CRED_DIR" ] && [ -f "$HOME/.claude/.credentials.json" ]; then
      FULL_CRED_DIR="$CRED_DIR"
      [[ "$FULL_CRED_DIR" != /* ]] && FULL_CRED_DIR="$REPO_DIR/$FULL_CRED_DIR"
      if [ -f "$FULL_CRED_DIR/claude-credentials.json" ]; then
        cp "$HOME/.claude/.credentials.json" "$FULL_CRED_DIR/claude-credentials.json"
      fi
    fi

    echo "[refresh-all] Refreshing credentials for $NAME → $SANDBOX ($(date))"
    CRED_FLAG=""
    [ -n "$CRED_DIR" ] && CRED_FLAG="--cred-dir $CRED_DIR"
    "$SCRIPT_DIR/refresh-credentials.sh" "$SANDBOX" $CRED_FLAG || {
      echo "[refresh-all] FAILED for $NAME ($SANDBOX) — continuing..."
    }
  done
else
  # Legacy single-user mode
  "$SCRIPT_DIR/refresh-credentials.sh"
fi
