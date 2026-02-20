#!/bin/sh
# Test: pnpm --version (Tier 1: pure JS, should work now)
exec /usr/local/bin/node /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs --version
