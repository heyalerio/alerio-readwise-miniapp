#!/usr/bin/env sh
set -eu

node_bin="${SANDBOX_NODE_BIN:-node}"

if [ -z "${SANDBOX_NODE_BIN:-}" ] && [ -x /usr/bin/node ]; then
  if /usr/bin/node -e "const major = Number(process.versions.node.split('.')[0]); process.exit(major >= 20 && major < 24 ? 0 : 1);"; then
    node_bin=/usr/bin/node
  fi
fi

exec "$node_bin" scripts/run-sandbox.mjs
