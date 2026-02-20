# Cross-compile Node.js v25.4.0 to a statically-linked RISC-V 64-bit ELF
# Uses musl-cross-make to build gcc 13.x toolchain (Node requires gcc >= 12.2.0)
# Usage: bash build.sh

# Stage 1: Build musl cross-toolchain from source (~10 min)
FROM ubuntu:24.04 AS toolchain

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    wget \
    xz-utils \
    rsync \
    python3 \
    texinfo \
    bison \
    flex \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/richfelker/musl-cross-make.git /mcm

WORKDIR /mcm

# Configure: riscv64-linux-musl target with gcc 13.3.0
# -march=rv64gc -mabi=lp64d to match our BusyBox binary exactly
# Use primary GNU FTP to avoid flaky mirror redirects in Docker
RUN printf '%s\n' \
    'TARGET = riscv64-linux-musl' \
    'GCC_VER = 14.2.0' \
    'BINUTILS_VER = 2.44' \
    'MUSL_VER = 1.2.5' \
    'GCC_CONFIG += --with-arch=rv64gc --with-abi=lp64d' \
    'GNU_SITE = https://ftp.gnu.org/gnu' \
    > config.mak

RUN make -j$(nproc) install OUTPUT=/opt/cross

# Stage 2: Build Node.js (~30-40 min)
FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    gcc \
    g++-14 \
    gcc-14 \
    wget \
    xz-utils \
    rsync \
    && rm -rf /var/lib/apt/lists/*

COPY --from=toolchain /opt/cross /opt/cross
# Cross tools go AFTER system tools so host ld/as aren't shadowed
ENV PATH="$PATH:/opt/cross/bin"

# Install Linux kernel headers into the cross sysroot under /usr so gcc
# finds them at <sysroot>/usr/include/linux/*
WORKDIR /tmp
RUN wget -q https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.6.68.tar.xz \
    && tar xf linux-6.6.68.tar.xz \
    && cd linux-6.6.68 \
    && make ARCH=riscv headers_install INSTALL_HDR_PATH=/opt/cross/riscv64-linux-musl/usr \
    && cd / && rm -rf /tmp/linux-6.6.68*

# Download Node.js v25.4.0 source
WORKDIR /build
RUN wget -q https://nodejs.org/dist/v25.4.0/node-v25.4.0.tar.xz \
    && tar xf node-v25.4.0.tar.xz \
    && rm node-v25.4.0.tar.xz

WORKDIR /build/node-v25.4.0

# Patch V8's highway SIMD library for RISC-V without RVV.
# Highway sets HWY_BROKEN_EMU128=1 for GCC < 16.0, which silently overrides
# HWY_COMPILE_ONLY_EMU128 and forces HWY_SCALAR. V8's json-stringifier needs
# 128-bit ops (FixedTag<uint8_t, 16>). Fix: pre-define HWY_BROKEN_EMU128=0
# before the guard, so HWY_COMPILE_ONLY_EMU128 actually takes effect.
RUN sed -i '1i /* rv64gc without RVV: force EMU128 */\n#define HWY_BROKEN_EMU128 0\n#define HWY_COMPILE_ONLY_EMU128' \
      deps/v8/third_party/highway/src/hwy/detect_targets.h && \
    head -5 deps/v8/third_party/highway/src/hwy/detect_targets.h

# Configure for RISC-V cross-compilation with musl
# - g++-14 as host compiler: system g++-13 has broken SVE overloads, clang has consteval bugs
# - --openssl-no-asm: avoids OpenSSL's platform-specific asm detection issues
# - --fully-static + LDFLAGS=-static: no dynamic linker needed in NanoVM
# - -march=rv64gc -mabi=lp64d: match BusyBox ISA/ABI (RVC + double-float)
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
      --without-npm \
      --openssl-no-asm

# Build with all available cores
RUN make -j$(nproc)

# Strip the binary for size
RUN riscv64-linux-musl-strip out/Release/node

# Stage 3: Just the binary
FROM scratch
COPY --from=builder /build/node-v25.4.0/out/Release/node /node
CMD ["/node"]
