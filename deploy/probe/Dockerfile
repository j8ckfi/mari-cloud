# syntax=docker/dockerfile:1
#
# GATE 1 probe image — mari-core's restore contract, run for real inside a
# Cloudflare Container.
#
# Contents:
#   * `marid`, the real supervisor, built for linux/amd64;
#   * mari-core's OWN compiled integration + unit test binaries (`cargo test
#     --no-run`), so the contract is asserted by the crate's own test bodies and
#     not by a re-implementation;
#   * `gate1_rootless`, one extra mari-core integration test copied in from the
#     probe lane, which adds the rootless-specific questions (setuid/setgid/
#     sticky, ownership, device nodes, production-chunker timing);
#   * a chunk store at /store seeded at BUILD time with a snapshot of a
#     reference tree, so a container start can do a real cold-wake restore with
#     no setup work polluting the measurement.
#
# The build context is `deploy/probe/ctx/`, populated by `mkctx.sh` (the repo
# root is not a usable Docker context: it holds `target/` and `node_modules/`).
#
# Cloudflare Containers are linux/amd64. The Rust compile runs NATIVELY on the
# build platform and cross-links for amd64, so only the small apt/seed layers
# are emulated.

# ---- stage 1: build marid + mari-core's test binaries for amd64 --------------
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS build

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends gcc-x86-64-linux-gnu libc6-dev-amd64-cross; \
    rm -rf /var/lib/apt/lists/*; \
    rustup target add x86_64-unknown-linux-gnu

ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
    CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc \
    AR_x86_64_unknown_linux_gnu=x86_64-linux-gnu-ar \
    CARGO_TERM_COLOR=never

WORKDIR /repo
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates

# The gate-1 test lives in deploy/probe/ and is placed into the crate's own
# tests/ directory only here, inside the build context, so it compiles as a
# first-class mari-core integration test and can use tests/common/mod.rs
# verbatim. The repo working tree is never modified.
COPY probe/gate1_rootless.rs ./crates/mari-core/tests/gate1_rootless.rs

ARG TGT=x86_64-unknown-linux-gnu
RUN set -eux; \
    cargo build -p marid --locked --release --target "$TGT"; \
    cargo test -p mari-core --locked --release --no-run --target "$TGT"; \
    mkdir -p /out/tests; \
    cp "target/$TGT/release/marid" /out/marid; \
    for f in "target/$TGT/release/deps/"*; do \
      case "$f" in *.*) continue ;; esac; \
      [ -f "$f" ] && [ -x "$f" ] || continue; \
      b="$(basename "$f")"; \
      cp "$f" "/out/tests/${b%-*}"; \
    done; \
    ls -l /out /out/tests

# ---- stage 2: the probe image (amd64 = TARGETPLATFORM) ----------------------
FROM debian:bookworm-slim

# libcap2-bin      -> capsh --print (the bounding-set question)
# fuse3            -> fusermount3, so the FUSE question is answerable
# util-linux       -> unshare/mount (already Essential, named for clarity)
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates libcap2-bin fuse3 util-linux procps; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /work /store /etc/mari/agents.d /opt/mari/tests /tmp/probe

COPY --from=build /out/marid /usr/local/bin/marid
COPY --from=build /out/tests/ /opt/mari/tests/
COPY probe/probe-env.sh  /usr/local/bin/probe-env.sh
COPY probe/probe-boot.sh /usr/local/bin/probe-boot.sh
COPY probe/idle.sh       /usr/local/bin/idle.sh
RUN chmod 0755 /usr/local/bin/probe-env.sh /usr/local/bin/probe-boot.sh \
               /usr/local/bin/idle.sh /opt/mari/tests/*

ENV MARI_ROOT=/work \
    MARI_STORE=fs:///store \
    MARI_AGENTS_DIR=/etc/mari/agents.d \
    RUST_LOG=info,marid=debug

# Seed the chunk store at build time and record the manifest id the boot script
# will restore. This is the base image carrying a manifest (spec 2), and it is
# what makes "container start -> cold-wake restore complete" a clean number.
ARG SEED_MIB=32
RUN set -eux; \
    MARI_PROBE_SEED_STORE=/store \
    MARI_PROBE_SEED_ROOT=/tmp/seed \
    MARI_PROBE_SEED_MIB="$SEED_MIB" \
    /opt/mari/tests/gate1_rootless gate1_seed_store_for_marid \
        --exact --ignored --nocapture --test-threads=1 > /tmp/seed.out 2>&1; \
    cat /tmp/seed.out; \
    grep -o 'MARI_PROBE_MANIFEST=[0-9a-f]*' /tmp/seed.out | head -1 | cut -d= -f2 \
        > /etc/mari/seed-manifest; \
    test -s /etc/mari/seed-manifest; \
    cp /tmp/seed.out /etc/mari/seed.log; \
    rm -rf /tmp/seed /tmp/seed.out; \
    du -sh /store

# The container runs unprivileged and its uid is not known at build time, so the
# store it must read AND write (restore + heat profile) and the root it restores
# into are made world-writable. This is a probe image, not the production base
# image.
RUN chmod -R 0777 /store /work /tmp/probe

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/idle.sh"]
