#!/bin/sh
# Test: tsc --version (Tier 1: pure JS, should work now)
exec /usr/local/bin/node /usr/local/lib/node_modules/typescript/bin/tsc --version
