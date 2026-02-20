# Multi-stage build: complete JS dev environment for NanoVM (RISC-V 64-bit)
# Produces devenv.tar.gz containing Node.js+npm, esbuild, and pure-JS tools.
#
# Usage: docker build -t nanovm-devenv -f Dockerfile .
#        docker run --rm nanovm-devenv cat /devenv.tar.gz > devenv.tar.gz

# ============================================================
# Stage 1: musl cross-toolchain (reuses node-riscv approach)
# ============================================================
FROM ubuntu:24.04 AS toolchain

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    build-essential git wget xz-utils rsync python3 texinfo bison flex \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/richfelker/musl-cross-make.git /mcm

WORKDIR /mcm

RUN printf '%s\n' \
    'TARGET = riscv64-linux-musl' \
    'GCC_VER = 14.2.0' \
    'BINUTILS_VER = 2.44' \
    'MUSL_VER = 1.2.5' \
    'GCC_CONFIG += --with-arch=rv64gc --with-abi=lp64d' \
    'GNU_SITE = https://ftp.gnu.org/gnu' \
    > config.mak

RUN make -j$(nproc) install OUTPUT=/opt/cross

# Install Linux kernel headers into cross sysroot
WORKDIR /tmp
RUN wget -q https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.6.68.tar.xz \
    && tar xf linux-6.6.68.tar.xz \
    && cd linux-6.6.68 \
    && make ARCH=riscv headers_install INSTALL_HDR_PATH=/opt/cross/riscv64-linux-musl/usr \
    && cd / && rm -rf /tmp/linux-6.6.68*

# ============================================================
# Stage 2: Build Node.js WITH npm (static RISC-V ELF)
# ============================================================
FROM ubuntu:24.04 AS node-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    python3 make gcc g++-14 gcc-14 wget xz-utils rsync \
    && rm -rf /var/lib/apt/lists/*

COPY --from=toolchain /opt/cross /opt/cross
ENV PATH="$PATH:/opt/cross/bin"

WORKDIR /build
RUN wget -q https://nodejs.org/dist/v25.4.0/node-v25.4.0.tar.xz \
    && tar xf node-v25.4.0.tar.xz \
    && rm node-v25.4.0.tar.xz

WORKDIR /build/node-v25.4.0

# Patch V8 highway for RISC-V without RVV (same as node-riscv build)
RUN sed -i '1i /* rv64gc without RVV: force EMU128 */\n#define HWY_BROKEN_EMU128 0\n#define HWY_COMPILE_ONLY_EMU128' \
      deps/v8/third_party/highway/src/hwy/detect_targets.h

# Configure WITH npm (--without-npm removed vs node-riscv build)
RUN CC=riscv64-linux-musl-gcc \
    CXX=riscv64-linux-musl-g++ \
    CC_host=gcc-14 \
    CXX_host=g++-14 \
    AR=riscv64-linux-musl-ar \
    RANLIB=riscv64-linux-musl-ranlib \
    CFLAGS="-O2 -pipe -march=rv64gc -mabi=lp64d" \
    CXXFLAGS="-O2 -pipe -march=rv64gc -mabi=lp64d" \
    LDFLAGS="-static" \
    ./configure \
      --dest-cpu=riscv64 \
      --dest-os=linux \
      --cross-compiling \
      --fully-static \
      --with-intl=none \
      --without-inspector \
      --openssl-no-asm

RUN make -j$(nproc)
RUN riscv64-linux-musl-strip out/Release/node

# ============================================================
# Stage 3: Cross-compile esbuild (Go -> RISC-V)
# ============================================================
FROM golang:1.23 AS esbuild-builder

RUN git clone --depth 1 --branch v0.25.0 https://github.com/evanw/esbuild.git /esbuild

WORKDIR /esbuild
RUN CGO_ENABLED=0 GOOS=linux GOARCH=riscv64 \
    go build -ldflags="-s -w" -o /usr/local/bin/esbuild ./cmd/esbuild

# ============================================================
# Stage 4: Cross-compile Rspack binding (Rust -> RISC-V musl)
# NOTE: This is complex and long-running (~30-60 min). The stage
# is included for completeness but can be skipped initially.
# Rspack requires NanoVM dlopen support (Tier 3).
# ============================================================
FROM ubuntu:24.04 AS rspack-builder

ENV DEBIAN_FRONTEND=noninteractive

# Install Rust toolchain
# Rspack cross-compilation is complex and requires NanoVM dlopen (Tier 3).
# For now, create a placeholder stage that produces an empty marker.
# When dlopen is supported, uncomment the full build below.
RUN mkdir -p /out && \
    echo "Rspack RISC-V build skipped - Tier 3 (needs dlopen)" > /out/RSPACK_NOT_BUILT

# ============================================================
# Stage 5: Assemble devenv with HOST Node.js (install pure-JS tools)
# ============================================================
FROM node:22 AS packager

# Create clean prefix structure
RUN mkdir -p /devenv/usr/local/bin \
             /devenv/usr/local/lib/node_modules

# Copy Node.js RISC-V binary (built WITH npm support)
COPY --from=node-builder /build/node-v25.4.0/out/Release/node /devenv/usr/local/bin/node

# Copy esbuild RISC-V binary
COPY --from=esbuild-builder /usr/local/bin/esbuild /devenv/usr/local/bin/esbuild

# Copy npm from the Node.js build (it's bundled in deps/npm when built without --without-npm)
COPY --from=node-builder /build/node-v25.4.0/deps/npm /devenv/usr/local/lib/node_modules/npm

# Install pure-JS tools globally into our prefix using HOST node/npm
ENV NPM_CONFIG_PREFIX=/devenv/usr/local

# Install tools one group at a time for better caching
RUN npm install -g pnpm@latest
RUN npm install -g typescript@latest
RUN npm install -g tsx@latest
RUN npm install -g eslint@latest
RUN npm install -g prettier@latest
RUN npm install -g vitest@latest
RUN npm install -g @rsbuild/core@latest || echo "rsbuild install skipped"
RUN npm install -g @anthropic-ai/claude-code@latest || echo "claude-code install skipped"

# Replace esbuild's platform-specific binary with our RISC-V cross-compiled one
# esbuild npm package tries to use a platform-specific optional dependency;
# we replace the binary it would spawn with our cross-compiled one.
RUN find /devenv/usr/local/lib/node_modules -path '*/esbuild/bin/esbuild' \
    -exec cp /devenv/usr/local/bin/esbuild {} \; 2>/dev/null || true
RUN find /devenv/usr/local/lib/node_modules -path '*/@esbuild/*/bin/esbuild' \
    -exec cp /devenv/usr/local/bin/esbuild {} \; 2>/dev/null || true

# Copy Rspack RISC-V .node binding if available
COPY --from=rspack-builder /out/ /tmp/rspack-out/
RUN if [ -f /tmp/rspack-out/rspack.linux-riscv64-musl.node ]; then \
      find /devenv/usr/local/lib/node_modules -path '*/@rspack/binding*' -name '*.node' \
        -exec cp /tmp/rspack-out/rspack.linux-riscv64-musl.node {} \; 2>/dev/null || true; \
    fi

# Create wrapper scripts in /usr/local/bin for each tool
# These are shell scripts that invoke node with the right module path

RUN cat > /devenv/usr/local/bin/npm <<'SCRIPT'
#!/bin/sh
exec /usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js "$@"
SCRIPT

RUN cat > /devenv/usr/local/bin/npx <<'SCRIPT'
#!/bin/sh
exec /usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npx-cli.js "$@"
SCRIPT

RUN cat > /devenv/usr/local/bin/pnpm <<'SCRIPT'
#!/bin/sh
exec /usr/local/bin/node /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs "$@"
SCRIPT

RUN cat > /devenv/usr/local/bin/tsc <<'SCRIPT'
#!/bin/sh
exec /usr/local/bin/node /usr/local/lib/node_modules/typescript/bin/tsc "$@"
SCRIPT

RUN cat > /devenv/usr/local/bin/tsx <<'SCRIPT'
#!/bin/sh
exec /usr/local/bin/node /usr/local/lib/node_modules/tsx/dist/cli.mjs "$@"
SCRIPT

RUN cat > /devenv/usr/local/bin/eslint <<'SCRIPT'
#!/bin/sh
exec /usr/local/bin/node /usr/local/lib/node_modules/eslint/bin/eslint.js "$@"
SCRIPT

RUN cat > /devenv/usr/local/bin/prettier <<'SCRIPT'
#!/bin/sh
exec /usr/local/bin/node /usr/local/lib/node_modules/prettier/bin/prettier.cjs "$@"
SCRIPT

RUN cat > /devenv/usr/local/bin/vitest <<'SCRIPT'
#!/bin/sh
exec /usr/local/bin/node /usr/local/lib/node_modules/vitest/vitest.mjs "$@"
SCRIPT

RUN cat > /devenv/usr/local/bin/rsbuild <<'SCRIPT'
#!/bin/sh
exec /usr/local/bin/node /usr/local/lib/node_modules/@rsbuild/core/bin/rsbuild.js "$@"
SCRIPT

RUN cat > /devenv/usr/local/bin/claude <<'SCRIPT'
#!/bin/sh
exec /usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js "$@"
SCRIPT

# Make all wrapper scripts executable
RUN chmod +x /devenv/usr/local/bin/*

# ============================================================
# Stage 6: Package as compressed tarball
# ============================================================
FROM ubuntu:24.04 AS archiver

COPY --from=packager /devenv /devenv

WORKDIR /devenv
RUN tar czf /devenv.tar.gz -C /devenv .

# Final: just the tarball
FROM scratch
COPY --from=archiver /devenv.tar.gz /devenv.tar.gz
