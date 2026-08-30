#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

HOST="${1:-http://192.168.0.147:8989}"

# Persistent npm cache on the host so package downloads survive across runs
# too (not just node_modules). Must be a bind-mounted host dir we already
# own, not a fresh named volume, or docker creates it root-owned and
# --user "$(id -u):$(id -g)" below gets EACCES writing to it.
NPM_CACHE_DIR="$HOME/.cache/pagetollm-npm"
mkdir -p "$NPM_CACHE_DIR"

sudo docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD:/app" \
  --volume "$NPM_CACHE_DIR:/npm-cache" \
  --workdir /app \
  --env HOST="$HOST" \
  --env npm_config_cache=/npm-cache \
  node:24 \
  sh -euc '
    stamp="node_modules/.install-stamp"
    hash="$(sha256sum package-lock.json | cut -d" " -f1)"
    if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$hash" ]; then
      echo "node_modules already matches package-lock.json, skipping npm ci"
    else
      npm ci
      echo "$hash" > "$stamp"
    fi

    npm run build

    node -e "
      const fs = require(\"fs\");
      const m = JSON.parse(fs.readFileSync(\"dist/manifest.json\"));
      const csp = m.content_security_policy.extension_pages;
      m.content_security_policy.extension_pages = csp
        .split(\";\")
        .map((part) => {
          const trimmed = part.trim();
          if (trimmed.startsWith(\"connect-src\")) {
            return trimmed + \" \" + process.env.HOST;
          }
          return trimmed;
        })
        .join(\"; \");
      fs.writeFileSync(\"dist/manifest.json\", JSON.stringify(m, null, 2));
    "
  '
