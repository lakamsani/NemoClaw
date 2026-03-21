#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Download workspace personality files from sandbox to host persist/ dir.
# Run before rebuilds or on a cron for continuous backup.
#
# Usage: ./scripts/nemoclaw-backup-workspace.sh [sandbox-name]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$REPO_DIR/.env" ]; then
  set -a; . "$REPO_DIR/.env"; set +a
fi

SANDBOX="${1:-${NEMOCLAW_SANDBOX:-my-assistant}}"
PERSIST_DIR="$REPO_DIR/persist/workspace"

mkdir -p "$PERSIST_DIR"

# Generate SSH config
openshell sandbox ssh-config "$SANDBOX" > "/tmp/ssh-config-${SANDBOX}" 2>/dev/null

# Download workspace files via tar over SSH
ssh -F "/tmp/ssh-config-${SANDBOX}" -o StrictHostKeyChecking=no "openshell-${SANDBOX}" \
  'cd /sandbox/.openclaw/workspace && tar czf - \
    SOUL.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md AGENTS.md BOOTSTRAP.md \
    .openclaw memory 2>/dev/null || true' \
  | tar xzf - -C "$PERSIST_DIR" 2>/dev/null

echo "[backup] Workspace downloaded to $PERSIST_DIR ($(date))"
