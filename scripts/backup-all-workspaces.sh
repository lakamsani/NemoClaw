#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Backup workspace files for all registered users.
# Falls back to single-sandbox backup if no users.json exists.
#
# Usage: ./scripts/backup-all-workspaces.sh

set -euo pipefail

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
    WORKSPACE_DIR=$(python3 -c "import json; print(json.load(open('$USERS_FILE'))['users']['$uid'].get('personalityDir','persist/workspace'))")
    NAME=$(python3 -c "import json; print(json.load(open('$USERS_FILE'))['users']['$uid'].get('slackDisplayName','$uid'))")

    # Resolve relative path
    if [[ "$WORKSPACE_DIR" != /* ]]; then
      WORKSPACE_DIR="$REPO_DIR/$WORKSPACE_DIR"
    fi

    mkdir -p "$WORKSPACE_DIR"

    echo "[backup-all] Backing up workspace for $NAME → $WORKSPACE_DIR ($(date))"

    # Generate SSH config
    openshell sandbox ssh-config "$SANDBOX" > "/tmp/ssh-config-${SANDBOX}" 2>/dev/null || {
      echo "[backup-all] Cannot get SSH config for $SANDBOX — skipping"
      continue
    }

    ssh -F "/tmp/ssh-config-${SANDBOX}" -o StrictHostKeyChecking=no "openshell-${SANDBOX}" \
      'cd /sandbox/.openclaw/workspace && tar czf - \
        SOUL.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md AGENTS.md BOOTSTRAP.md \
        .openclaw memory 2>/dev/null || true' \
      | tar xzf - -C "$WORKSPACE_DIR" 2>/dev/null || {
      echo "[backup-all] Backup failed for $NAME ($SANDBOX) — continuing..."
    }
  done
else
  # Legacy single-user mode
  "$SCRIPT_DIR/nemoclaw-backup-workspace.sh"
fi
