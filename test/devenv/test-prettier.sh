#!/bin/sh
# Test: prettier --version (Tier 1: pure JS, should work now)
exec /usr/local/bin/node /usr/local/lib/node_modules/prettier/bin/prettier.cjs --version
