#!/bin/sh
# Stop a Mari private instance.
#
#   ./deploy/down.sh              stop the control plane; computers keep running
#   ./deploy/down.sh --computers  ...and destroy every AWAKE/WARM computer
#   ./deploy/down.sh --purge      ...and delete the fleet (every computer, for good)
#
# A computer is a container the control plane created through the Docker socket,
# not a service in this stack, so stopping the control plane leaves an AWAKE one
# running — by design: it keeps its supervisor, and when the control plane comes
# back that supervisor reconnects with the epoch it already holds (spec 4.1).
#
# `--purge` deletes the `mari-store` volume, and the chunk store is the home of
# every computer (spec §2). There is no other copy.
set -eu

CONTAINER=${MARI_CONTAINER:-mari-control-plane}
STORE_VOLUME=${MARI_STORE_VOLUME:-mari-store}
DATA_VOLUME=${MARI_DATA_VOLUME:-mari-data}
COMPUTERS=0
PURGE=0

for arg in "$@"; do
  case "$arg" in
    --computers) COMPUTERS=1 ;;
    --purge) COMPUTERS=1; PURGE=1 ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "down.sh: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

command -v docker >/dev/null 2>&1 || { echo "down.sh: no 'docker' on PATH" >&2; exit 1; }

if [ -n "$(docker ps -aq --filter "name=^${CONTAINER}$")" ]; then
  say "stopping $CONTAINER"
  # SIGTERM first: the control plane drains background work and closes SQLite.
  docker rm -f "$CONTAINER" >/dev/null
else
  say "$CONTAINER is not running"
fi

if [ "$COMPUTERS" = 1 ]; then
  ids=$(docker ps -aq --filter label=mari.computer)
  if [ -n "$ids" ]; then
    say "destroying $(echo "$ids" | wc -l | tr -d ' ') computer container(s)"
    # shellcheck disable=SC2086
    docker rm -f $ids >/dev/null
  fi
fi

if [ "$PURGE" = 1 ]; then
  printf 'Delete volumes %s and %s? Every computer is gone for good. [y/N] ' \
    "$STORE_VOLUME" "$DATA_VOLUME"
  read -r reply
  case "$reply" in
    y|Y|yes|YES)
      docker volume rm "$STORE_VOLUME" "$DATA_VOLUME" >/dev/null 2>&1 || true
      say "fleet deleted"
      ;;
    *) say "kept the volumes" ;;
  esac
fi
