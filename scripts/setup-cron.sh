#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Idempotent cron setup for NemoClaw. Safe to run multiple times.
# Restores credential refresh and workspace backup cron jobs.
# Multi-user aware: uses refresh-all/backup-all scripts when users.json exists.
#
# Usage: ./scripts/setup-cron.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

CRON_ENTRIES=(
  "# NemoClaw credential refresh — all users (every 1 hour)"
  "0 */1 * * * $SCRIPT_DIR/refresh-all-credentials.sh >> /tmp/nemoclaw-cred-refresh.log 2>&1"
  "# NemoClaw workspace backup — all users (every 2 hours)"
  "0 */2 * * * $SCRIPT_DIR/backup-all-workspaces.sh >> /tmp/nemoclaw-workspace-backup.log 2>&1"
)

# Get existing crontab (without NemoClaw entries)
EXISTING=$(crontab -l 2>/dev/null | grep -v 'NemoClaw\|nemoclaw-cred-refresh\|nemoclaw-workspace-backup\|refresh-credentials\|nemoclaw-backup\|refresh-all\|backup-all' || true)

# Build new crontab
{
  [ -n "$EXISTING" ] && echo "$EXISTING"
  for entry in "${CRON_ENTRIES[@]}"; do
    echo "$entry"
  done
} | crontab -

echo "[cron] NemoClaw cron jobs installed:"
crontab -l | grep -A1 NemoClaw
