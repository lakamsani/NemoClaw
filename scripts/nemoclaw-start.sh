#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint. Configures OpenClaw and starts the dashboard
# gateway inside the sandbox so the forwarded host port has a live upstream.
#
# Optional env:
#   NVIDIA_API_KEY   API key for NVIDIA-hosted inference
#   CHAT_UI_URL      Browser origin that will access the forwarded dashboard

set -euo pipefail

NEMOCLAW_CMD=("$@")
CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:18789}"
PUBLIC_PORT=18789

fix_openclaw_config() {
  python3 - <<'PYCFG'
import json
import os
from urllib.parse import urlparse

home = os.environ.get('HOME', '/sandbox')
config_path = os.path.join(home, '.openclaw', 'openclaw.json')
os.makedirs(os.path.dirname(config_path), exist_ok=True)

cfg = {}
if os.path.exists(config_path):
    with open(config_path) as f:
        cfg = json.load(f)

default_model = os.environ.get('NEMOCLAW_MODEL')
if default_model:
    cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = default_model

chat_ui_url = os.environ.get('CHAT_UI_URL', 'http://127.0.0.1:18789')
parsed = urlparse(chat_ui_url)
chat_origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else 'http://127.0.0.1:18789'
local_origin = f'http://127.0.0.1:{os.environ.get("PUBLIC_PORT", "18789")}'
origins = [local_origin]
if chat_origin not in origins:
    origins.append(chat_origin)

gateway = cfg.setdefault('gateway', {})
gateway['mode'] = 'local'
gateway['controlUi'] = {
    'allowInsecureAuth': True,
    'dangerouslyDisableDeviceAuth': True,
    'allowedOrigins': origins,
}
gateway['trustedProxies'] = ['127.0.0.1', '::1']

# Gateway auth token (from env or existing config)
gw_token = os.environ.get('GATEWAY_AUTH_TOKEN', '')
if gw_token:
    gateway['auth'] = {'mode': 'token', 'token': gw_token}
elif 'auth' not in gateway:
    import secrets
    gateway['auth'] = {'mode': 'token', 'token': secrets.token_hex(24)}

with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2)
os.chmod(config_path, 0o600)
PYCFG
}

write_auth_profile() {
  python3 - <<'PYAUTH'
import json
import os

profiles = {}

if os.environ.get('NVIDIA_API_KEY'):
    profiles['nvidia:manual'] = {
        'type': 'api_key',
        'provider': 'nvidia',
        'keyRef': {'source': 'env', 'id': 'NVIDIA_API_KEY'},
        'profileId': 'nvidia:manual',
    }

if os.environ.get('ANTHROPIC_API_KEY'):
    profiles['anthropic:manual'] = {
        'type': 'api_key',
        'provider': 'anthropic',
        'keyRef': {'source': 'env', 'id': 'ANTHROPIC_API_KEY'},
        'profileId': 'anthropic:manual',
    }

if profiles:
    path = os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(profiles, open(path, 'w'))
    os.chmod(path, 0o600)
PYAUTH
}

extract_anthropic_key() {
  # Extract ANTHROPIC_API_KEY from Claude credentials if not already set
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    return
  fi
  ANTHROPIC_API_KEY="$(python3 - <<'PYKEY'
import json, os
cred_path = os.path.expanduser('~/.claude/.credentials.json')
try:
    creds = json.load(open(cred_path))
    token = creds.get('claudeAiOauth', {}).get('accessToken', '')
    if token:
        print(token, end='')
except Exception:
    pass
PYKEY
)"
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    export ANTHROPIC_API_KEY
    echo "[credentials] ANTHROPIC_API_KEY extracted from Claude credentials"
  fi
}

print_dashboard_urls() {
  local token chat_ui_base local_url remote_url

  token="$(python3 - <<'PYTOKEN'
import json
import os
path = os.path.expanduser('~/.openclaw/openclaw.json')
try:
    cfg = json.load(open(path))
except Exception:
    print('')
else:
    print(cfg.get('gateway', {}).get('auth', {}).get('token', ''))
PYTOKEN
)"

  chat_ui_base="${CHAT_UI_URL%/}"
  local_url="http://127.0.0.1:${PUBLIC_PORT}/"
  remote_url="${chat_ui_base}/"
  if [ -n "$token" ]; then
    local_url="${local_url}#token=${token}"
    remote_url="${remote_url}#token=${token}"
  fi

  echo "[gateway] Local UI: ${local_url}"
  echo "[gateway] Remote UI: ${remote_url}"
}

start_auto_pair() {
  nohup python3 - <<'PYAUTOPAIR' >> /tmp/gateway.log 2>&1 &
import json
import subprocess
import time

DEADLINE = time.time() + 600
QUIET_POLLS = 0
APPROVED = 0

def run(*args):
    proc = subprocess.run(args, capture_output=True, text=True)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()

while time.time() < DEADLINE:
    rc, out, err = run('openclaw', 'devices', 'list', '--json')
    if rc != 0 or not out:
        time.sleep(1)
        continue
    try:
        data = json.loads(out)
    except Exception:
        time.sleep(1)
        continue

    pending = data.get('pending') or []
    paired = data.get('paired') or []
    has_browser = any((d.get('clientId') == 'openclaw-control-ui') or (d.get('clientMode') == 'webchat') for d in paired if isinstance(d, dict))

    if pending:
        QUIET_POLLS = 0
        for device in pending:
            request_id = (device or {}).get('requestId')
            if not request_id:
                continue
            arc, aout, aerr = run('openclaw', 'devices', 'approve', request_id, '--json')
            if arc == 0:
                APPROVED += 1
                print(f'[auto-pair] approved request={request_id}')
            elif aout or aerr:
                print(f'[auto-pair] approve failed request={request_id}: {(aerr or aout)[:400]}')
        time.sleep(1)
        continue

    if has_browser:
        QUIET_POLLS += 1
        if QUIET_POLLS >= 4:
            print(f'[auto-pair] browser pairing converged approvals={APPROVED}')
            break
    elif APPROVED > 0:
        QUIET_POLLS += 1
    else:
        QUIET_POLLS = 0

    time.sleep(1)
else:
    print(f'[auto-pair] watcher timed out approvals={APPROVED}')
PYAUTOPAIR
  echo "[gateway] auto-pair watcher launched (pid $!)"
}

inject_claude_credentials() {
  # If CLAUDE_CREDENTIALS_JSON is set, write it to ~/.claude/.credentials.json
  if [ -n "${CLAUDE_CREDENTIALS_JSON:-}" ]; then
    mkdir -p /sandbox/.claude
    echo "$CLAUDE_CREDENTIALS_JSON" > /sandbox/.claude/.credentials.json
    chmod 600 /sandbox/.claude/.credentials.json
    echo "[credentials] Claude credentials injected from env"
  fi
}

inject_github_token() {
  # If GH_TOKEN is set, write gh CLI hosts config
  if [ -n "${GH_TOKEN:-}" ]; then
    mkdir -p /sandbox/.config/gh
    cat > /sandbox/.config/gh/hosts.yml <<GHEOF
github.com:
  oauth_token: ${GH_TOKEN}
  user: ${GH_USER:-user}
  git_protocol: https
GHEOF
    chmod 600 /sandbox/.config/gh/hosts.yml
    echo "[credentials] GitHub token injected from env"
  fi
}

inject_google_credentials() {
  # If GOOGLE_APPLICATION_CREDENTIALS points to a file inside the sandbox, nothing to do.
  # If GOOGLE_SA_JSON is set (base64-encoded service account JSON), decode and write it.
  if [ -n "${GOOGLE_SA_JSON:-}" ]; then
    mkdir -p /sandbox/.config/gcloud
    echo "$GOOGLE_SA_JSON" | base64 -d > /sandbox/.config/gcloud/service-account.json
    chmod 600 /sandbox/.config/gcloud/service-account.json
    export GOOGLE_APPLICATION_CREDENTIALS=/sandbox/.config/gcloud/service-account.json
    echo "[credentials] Google service account injected from env"
  fi
}

inject_gog_credentials() {
  # If GOG_CONFIG_JSON is set (base64-encoded gogcli directory), decode and write it
  if [ -n "${GOG_CONFIG_JSON:-}" ]; then
    mkdir -p /sandbox/.config/gogcli/keyring /sandbox/.config/gogcli/tokens
    echo "$GOG_CONFIG_JSON" | base64 -d | tar xz -C /sandbox/.config/gogcli/
    chmod -R 700 /sandbox/.config/gogcli
    echo "[credentials] gog OAuth credentials injected from env"
  fi
}

update_anthropic_apikey_in_config() {
  # Patch the runtime openclaw.json with the actual ANTHROPIC_API_KEY
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    return
  fi
  python3 - <<'PYPATCH'
import json, os
path = os.path.expanduser('~/.openclaw/openclaw.json')
try:
    cfg = json.load(open(path))
except Exception:
    cfg = {}
providers = cfg.setdefault('models', {}).setdefault('providers', {})
if 'anthropic' in providers:
    providers['anthropic']['apiKey'] = os.environ['ANTHROPIC_API_KEY']
cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'anthropic/claude-sonnet-4-6'
json.dump(cfg, open(path, 'w'), indent=2)
os.chmod(path, 0o600)
PYPATCH
  echo "[config] openclaw.json updated with Anthropic API key and default model"
}

inject_slack_webhook() {
  # Persist SLACK_WEBHOOK_URL to /sandbox/.env for heartbeat notifications
  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    if grep -q SLACK_WEBHOOK_URL /sandbox/.env 2>/dev/null; then
      sed -i "s|^SLACK_WEBHOOK_URL=.*|SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}|" /sandbox/.env
    else
      echo "SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}" >> /sandbox/.env
    fi
    chmod 600 /sandbox/.env
    echo "[credentials] Slack webhook URL injected"
  fi
}

inject_gog_keyring_password() {
  # Persist GOG_KEYRING_PASSWORD to /sandbox/.env for headless gog auth (heartbeat)
  local pw="${GOG_KEYRING_PASSWORD:-nemoclaw}"
  if grep -q GOG_KEYRING_PASSWORD /sandbox/.env 2>/dev/null; then
    sed -i "s|^GOG_KEYRING_PASSWORD=.*|GOG_KEYRING_PASSWORD=${pw}|" /sandbox/.env
  else
    echo "GOG_KEYRING_PASSWORD=${pw}" >> /sandbox/.env
  fi
  chmod 600 /sandbox/.env
  echo "[credentials] GOG_KEYRING_PASSWORD injected"
}

echo 'Setting up NemoClaw...'
openclaw doctor --fix > /dev/null 2>&1 || true
inject_claude_credentials
extract_anthropic_key
inject_github_token
inject_google_credentials
inject_gog_credentials
inject_slack_webhook
inject_gog_keyring_password
write_auth_profile
export CHAT_UI_URL PUBLIC_PORT
fix_openclaw_config
update_anthropic_apikey_in_config
openclaw plugins install /opt/nemoclaw > /dev/null 2>&1 || true

if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  exec "${NEMOCLAW_CMD[@]}"
fi

nohup openclaw gateway run > /tmp/gateway.log 2>&1 &
echo "[gateway] openclaw gateway launched (pid $!)"
start_auto_pair
print_dashboard_urls
