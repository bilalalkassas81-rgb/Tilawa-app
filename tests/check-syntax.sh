#!/bin/sh
# Check every browser script as an ES module (plain `node --check` misses module-only errors).
set -e
tmp=$(mktemp -d)
for f in www/js/*.js; do cp "$f" "$tmp/$(basename "$f" .js).mjs"; node --check "$tmp/$(basename "$f" .js).mjs"; done
node --check www/sw.js
echo "syntax ok"
