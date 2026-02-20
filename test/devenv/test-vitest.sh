#!/bin/sh
# Test: vitest --version (Tier 2: needs esbuild via Vite)
exec /usr/local/bin/node /usr/local/lib/node_modules/vitest/vitest.mjs --version
