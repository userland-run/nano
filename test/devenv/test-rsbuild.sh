#!/bin/sh
# Test: rsbuild --version (Tier 3: needs dlopen for @rspack/binding)
exec /usr/local/bin/node /usr/local/lib/node_modules/@rsbuild/core/bin/rsbuild.js --version
