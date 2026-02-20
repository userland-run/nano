#!/bin/sh
# Test: tsx --version (Tier 2: needs esbuild child process via posix_spawn)
exec /usr/local/bin/node /usr/local/lib/node_modules/tsx/dist/cli.mjs --version
