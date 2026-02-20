#!/bin/sh
# Test: eslint --version (Tier 1: pure JS, should work now)
exec /usr/local/bin/node /usr/local/lib/node_modules/eslint/bin/eslint.js --version
