#!/bin/sh
# Test: claude --version (Tier 1: pure JS, needs network for API calls)
exec /usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --version
