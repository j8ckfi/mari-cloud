#!/bin/sh
# Entrypoint of the private-instance control plane.
#
# Everything it does is a precondition the process itself cannot fix from the
# inside, so it fails LOUDLY here rather than at first wake:
#
#   * the chunk store and data directories exist and are writable;
#   * the Docker socket is mounted (a private instance with no substrate can
#     create a computer but never wake one, spec 3.6/3.7);
#   * the chunk store the CONTROL PLANE writes and the one a COMPUTER mounts are
#     the same store — `MARI_STORE_HOST_DIR` is what the daemon binds into each
#     container (a named volume or a host path), and getting it wrong produces a
#     computer that restores from an empty store.
set -eu

DATA_DIR="${MARI_DATA_DIR:-/var/lib/mari/data}"
STORE_DIR="${MARI_STORE_DIR:-/var/lib/mari/store}"

mkdir -p "$DATA_DIR" "$STORE_DIR"

if [ ! -w "$DATA_DIR" ] || [ ! -w "$STORE_DIR" ]; then
  echo "mari: $DATA_DIR and $STORE_DIR must be writable" >&2
  exit 1
fi

DOCKER_SOCK="${DOCKER_HOST:-}"
DOCKER_SOCK="${DOCKER_SOCK#unix://}"
[ -n "$DOCKER_SOCK" ] || DOCKER_SOCK=/var/run/docker.sock
if [ "${SUBSTRATE_MODE:-docker}" != "fake" ] && [ ! -S "$DOCKER_SOCK" ]; then
  echo "mari: no Docker socket at $DOCKER_SOCK." >&2
  echo "      Mount it (-v /var/run/docker.sock:/var/run/docker.sock) or set SUBSTRATE_MODE=fake." >&2
  exit 1
fi

if [ -z "${MARI_STORE_HOST_DIR:-}" ]; then
  echo "mari: MARI_STORE_HOST_DIR is unset." >&2
  echo "      It names the chunk store AS THE DOCKER DAEMON SEES IT (a named volume" >&2
  echo "      or host path); each computer bind-mounts it at ${MARI_STORE_MOUNT:-/store}." >&2
  exit 1
fi

if [ "${AUTH_SECRET:-}" = "mari-private-instance-change-me" ] || [ -z "${AUTH_SECRET:-}" ]; then
  echo "mari: WARNING - AUTH_SECRET is unset or the default. Set it to a random 32+ char value." >&2
fi

exec node /app/node.mjs "$@"
