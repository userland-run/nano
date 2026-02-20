#!/bin/bash
# Build the complete JS dev environment tarball for NanoVM.
# Output: build/devenv.tar.gz (compressed tarball of /usr/local/{bin,lib})
#
# This builds Node.js (with npm), esbuild, and installs pure-JS tools
# (pnpm, TypeScript, tsx, ESLint, Prettier, Vitest, rsbuild, Claude Code).
#
# Usage: bash build/devenv/build.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_NAME="nanovm-devenv"
OUTPUT="$PROJECT_ROOT/build/devenv.tar.gz"

echo "=== Building NanoVM JS Dev Environment ==="
echo "    Docker image: $IMAGE_NAME"
echo "    Output:       $OUTPUT"
echo ""
echo "    This will build:"
echo "      - Node.js v25.4.0 (RISC-V, static, WITH npm)"
echo "      - esbuild v0.25.0 (RISC-V, Go cross-compile)"
echo "      - pnpm, TypeScript, tsx, ESLint, Prettier, Vitest"
echo "      - rsbuild (optional), Claude Code (optional)"
echo ""
echo "    First build takes ~60-90 minutes (toolchain + Node.js)."
echo "    Subsequent builds are cached by Docker."
echo ""

# Build the Docker image (this does the actual compilation + packaging)
echo "[1/3] Building Docker image..."
docker build \
    --progress=plain \
    -t "$IMAGE_NAME" \
    -f "$SCRIPT_DIR/Dockerfile" \
    "$SCRIPT_DIR" 2>&1

# Extract the tarball
echo "[2/3] Extracting devenv.tar.gz..."
CONTAINER_ID=$(docker create "$IMAGE_NAME" /dev/null)
docker cp "$CONTAINER_ID:/devenv.tar.gz" "$OUTPUT"
docker rm "$CONTAINER_ID" > /dev/null

# Verify
echo "[3/3] Verifying..."
ls -lh "$OUTPUT"
echo ""

# Show contents summary
echo "Tarball contents (top-level):"
tar tzf "$OUTPUT" | head -30
echo "..."
echo ""

TOTAL_FILES=$(tar tzf "$OUTPUT" | wc -l)
echo "Total files: $TOTAL_FILES"
echo ""
echo "=== Done! Tarball at: $OUTPUT ==="
echo ""
echo "To build WASM with embedded devenv:"
echo "  make build-bundled"
