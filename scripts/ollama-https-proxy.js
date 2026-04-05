#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// HTTPS reverse proxy for Ollama — allows sandbox pods to reach
// Ollama (plain HTTP on :11434) through the OpenShell HTTPS-only proxy.
//
// Listens on HTTPS :11435 with a self-signed cert, forwards to http://localhost:11434.
// Add ollama-proxy.local:11435 to the sandbox network policy.

const https = require("https");
const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const LISTEN_PORT = 11435;
const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const CERT_DIR = "/tmp/ollama-proxy-certs";

// Generate self-signed cert if needed
function ensureCerts() {
  const keyPath = path.join(CERT_DIR, "key.pem");
  const certPath = path.join(CERT_DIR, "cert.pem");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return { keyPath, certPath };

  fs.mkdirSync(CERT_DIR, { recursive: true });
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 365 -nodes -subj "/CN=ollama-proxy" 2>/dev/null`);
  return { keyPath, certPath };
}

const { keyPath, certPath } = ensureCerts();

const server = https.createServer(
  {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  },
  (clientReq, clientRes) => {
    const proxyReq = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: clientReq.url,
        method: clientReq.method,
        headers: { ...clientReq.headers, host: `${OLLAMA_HOST}:${OLLAMA_PORT}` },
      },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
      }
    );

    proxyReq.on("error", (err) => {
      console.error(`[ollama-proxy] ${err.message}`);
      clientRes.writeHead(502);
      clientRes.end("Bad Gateway: Ollama unreachable");
    });

    clientReq.pipe(proxyReq);
  }
);

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`[ollama-proxy] HTTPS reverse proxy listening on :${LISTEN_PORT} → http://${OLLAMA_HOST}:${OLLAMA_PORT}`);
});
