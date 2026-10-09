# The Linux CI and release environment: the main host's distribution (Ubuntu
# 24.04, so the main node's native modules match its glibc), with every tool
# pinned and verified. Built per runner; the layer cache keeps rebuilds cheap.
FROM ubuntu:24.04

ARG NODE_VERSION=24.12.0
ARG PNPM_VERSION=10.18.3
ARG CADDY_VERSION=2.11.7
ARG RUST_TOOLCHAIN=stable

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl git openssl procps python3 xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Node from nodejs.org, checked against the release's SHASUMS256.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64;   sum=bdebee276e58d0ef5448f3d5ac12c67daa963dd5e0a9bb621a53d1cefbc852fd ;; \
      arm64) arch=arm64; sum=a06d42807fb500f7459e5f3fa6cb431447352826ee6f07e14adfeec58a1b3210 ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    file="node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    curl -fsSLo "/tmp/$file" "https://nodejs.org/dist/v${NODE_VERSION}/$file"; \
    echo "$sum  /tmp/$file" | sha256sum -c -; \
    tar -xJf "/tmp/$file" -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude LICENSE --exclude README.md; \
    rm "/tmp/$file"; \
    node --version

ENV COREPACK_HOME=/usr/local/corepack
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate && chmod -R a+rX "$COREPACK_HOME"

# Caddy from its GitHub release, checked against the release's SHA-512 sums.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) sum=a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7 ;; \
      arm64) sum=3db36ba90c7a6e8dda40ee3dd71fa08844c76b5fb08f61b31e5e78d2ed38e71c51dc7baed875e50d1ca1279196e84302967237386ae87c91ae9f2aaceada682e ;; \
    esac; \
    file="caddy_${CADDY_VERSION}_linux_$(dpkg --print-architecture).tar.gz"; \
    curl -fsSLo "/tmp/$file" "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/$file"; \
    echo "$sum  /tmp/$file" | sha512sum -c -; \
    tar -xzf "/tmp/$file" -C /usr/local/bin caddy; \
    rm "/tmp/$file"; \
    caddy version

# Rust through rustup, as on the macOS runner.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --component rustfmt --default-toolchain "$RUST_TOOLCHAIN" \
 && rustc --version
