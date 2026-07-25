#!/bin/sh
# Populate deploy/probe/ctx/ — the Docker build context for the gate-1 probe
# image. The repo root cannot be the context (target/ and node_modules/ are
# gigabytes), and Docker will not follow symlinks out of a context, so the few
# things the image needs are copied in.
#
# Idempotent. Everything it writes is under deploy/probe/ctx/ and is disposable.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
ctx="$here/ctx"

rm -rf "$ctx"
mkdir -p "$ctx/probe"

cp "$repo/Cargo.toml"  "$ctx/Cargo.toml"
cp "$repo/Cargo.lock"  "$ctx/Cargo.lock"

# Rust sources only: no target/, no editor droppings.
mkdir -p "$ctx/crates"
for c in mari-proto mari-core marid; do
  mkdir -p "$ctx/crates/$c"
  cp "$repo/crates/$c/Cargo.toml" "$ctx/crates/$c/Cargo.toml"
  cp -R "$repo/crates/$c/src" "$ctx/crates/$c/src"
  if [ -d "$repo/crates/$c/tests" ]; then
    cp -R "$repo/crates/$c/tests" "$ctx/crates/$c/tests"
  fi
done

cp "$here/gate1_rootless.rs" "$ctx/probe/gate1_rootless.rs"
cp "$here/probe-env.sh"      "$ctx/probe/probe-env.sh"
cp "$here/probe-boot.sh"     "$ctx/probe/probe-boot.sh"
cp "$here/idle.sh"           "$ctx/probe/idle.sh"

echo "context ready: $ctx"
du -sh "$ctx"
