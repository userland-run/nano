#!/bin/bash
# Build Node.js v25.4.0 as a static RISC-V 64-bit ELF
# Output: ../../images/node (statically-linked riscv64 ELF)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_NAME="nanovm-node-riscv"
OUTPUT="$PROJECT_ROOT/images/node"

echo "=== Building Node.js v25.4.0 for RISC-V 64-bit ==="
echo "    Docker image: $IMAGE_NAME"
echo "    Output:       $OUTPUT"
echo ""

# Build the Docker image (this does the actual compilation)
echo "[1/3] Building Docker image (cross-compiling Node.js)..."
docker build \
    --progress=plain \
    -t "$IMAGE_NAME" \
    -f "$SCRIPT_DIR/Dockerfile" \
    "$SCRIPT_DIR" 2>&1

# Extract the binary
echo "[2/3] Extracting binary..."
CONTAINER_ID=$(docker create "$IMAGE_NAME")
docker cp "$CONTAINER_ID:/node" "$OUTPUT"
docker rm "$CONTAINER_ID" > /dev/null

# Verify
echo "[3/3] Verifying..."
file "$OUTPUT"
ls -lh "$OUTPUT"

echo ""
echo "=== Done! Binary at: $OUTPUT ==="
