#!/bin/sh
# Test: npm --version (Tier 1: pure JS, should work now)
exec /usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js --version
