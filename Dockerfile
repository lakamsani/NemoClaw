# NemoClaw sandbox image — OpenClaw + NemoClaw plugin inside OpenShell

FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        curl git ca-certificates \
        iproute2 \
    && rm -rf /var/lib/apt/lists/*

# Create sandbox user (matches OpenShell convention)
RUN groupadd -r sandbox && useradd -r -g sandbox -d /sandbox -s /bin/bash sandbox \
    && mkdir -p /sandbox/.openclaw /sandbox/.nemoclaw \
    && chown -R sandbox:sandbox /sandbox

# Install OpenClaw CLI
RUN npm install -g openclaw@2026.3.11

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install GitHub CLI (gh)
RUN ARCH=$(dpkg --print-architecture) && \
    curl -sL "https://github.com/cli/cli/releases/download/v2.67.0/gh_2.67.0_linux_${ARCH}.tar.gz" \
    | tar xz -C /tmp && cp /tmp/gh_*/bin/gh /usr/local/bin/gh && rm -rf /tmp/gh_*

# Install gog CLI (Google OAuth helper for headless environments)
RUN ARCH=$(dpkg --print-architecture) && \
    GOG_ARCH=$([ "$ARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    curl -sL "https://github.com/steipete/gogcli/releases/download/v0.12.0/gogcli_0.12.0_linux_${GOG_ARCH}.tar.gz" \
    | tar xz -C /tmp && cp /tmp/gog /usr/local/bin/gog && chmod +x /usr/local/bin/gog && rm -f /tmp/gog

# Install xurl (X/Twitter API CLI)
RUN ARCH=$(dpkg --print-architecture) && \
    XURL_ARCH=$([ "$ARCH" = "arm64" ] && echo "arm64" || echo "x86_64") && \
    curl -sL "https://github.com/xdevplatform/xurl/releases/download/v1.0.3/xurl_Linux_${XURL_ARCH}.tar.gz" \
    | tar xz -C /tmp && cp /tmp/xurl /usr/local/bin/xurl && chmod +x /usr/local/bin/xurl && rm -f /tmp/xurl

# Install PyYAML for blueprint runner
RUN pip3 install --break-system-packages pyyaml

# Copy our plugin and blueprint into the sandbox
COPY nemoclaw/dist/ /opt/nemoclaw/dist/
COPY nemoclaw/openclaw.plugin.json /opt/nemoclaw/
COPY nemoclaw/package.json /opt/nemoclaw/
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/

# Install runtime dependencies only (no devDependencies, no build step)
WORKDIR /opt/nemoclaw
RUN npm install --omit=dev

# Set up blueprint for local resolution
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/

# Copy startup script
COPY scripts/nemoclaw-start.sh /usr/local/bin/nemoclaw-start
RUN chmod +x /usr/local/bin/nemoclaw-start

WORKDIR /sandbox
USER sandbox

# Pre-create OpenClaw directories
RUN mkdir -p /sandbox/.openclaw/agents/main/agent \
    && chmod 700 /sandbox/.openclaw

# Write openclaw.json: Claude Sonnet 4.6 as default, nvidia as fallback.
# ANTHROPIC_API_KEY is injected at runtime from Claude credentials.
RUN python3 -c "\
import json, os; \
config = { \
    'agents': {'defaults': {'model': {'primary': 'anthropic/claude-sonnet-4-6'}}}, \
    'models': {'mode': 'merge', 'providers': { \
        'anthropic': { \
            'baseUrl': 'https://api.anthropic.com/v1', \
            'apiKey': 'injected-at-runtime', \
            'api': 'anthropic-messages', \
            'models': [{'id': 'claude-sonnet-4-6', 'name': 'Claude Sonnet 4.6', 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 200000, 'maxTokens': 64000}] \
        }, \
        'nvidia': { \
            'baseUrl': 'https://inference.local/v1', \
            'apiKey': 'openshell-managed', \
            'api': 'openai-completions', \
            'models': [{'id': 'nemotron-3-super-120b-a12b', 'name': 'NVIDIA Nemotron 3 Super 120B', 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 131072, 'maxTokens': 4096}] \
        } \
    }} \
}; \
path = os.path.expanduser('~/.openclaw/openclaw.json'); \
json.dump(config, open(path, 'w'), indent=2); \
os.chmod(path, 0o600)"

# Install NemoClaw plugin into OpenClaw
RUN openclaw doctor --fix > /dev/null 2>&1 || true \
    && openclaw plugins install /opt/nemoclaw > /dev/null 2>&1 || true

ENTRYPOINT ["/bin/bash"]
CMD []
