#!/bin/sh
# A Mari private instance: ONE command (spec 11.2).
#
#   ./deploy/up.sh
#
# Prerequisites: a Docker daemon and this repository. Nothing else — no Node, no
# pnpm, no Rust on the host. Both images build from this repo.
#
# WHY THIS IS A SCRIPT AND NOT `docker compose up`
# ------------------------------------------------
# `docker compose` is a CLI *plugin*. Docker Engine on Linux, Colima, Rancher
# Desktop and Podman all give you a working daemon WITHOUT it, and Homebrew's
# `docker` formula does not depend on it either — so "one command" cannot be a
# compose command without also being a second install step. This script uses
# nothing but `docker` subcommands that ship with the CLI itself.
#
# `deploy/docker-compose.yml` is still there and still correct; it describes the
# same two images, the same two named volumes and the same environment. If you
# have the plugin, either path works. See deploy/README.md.
#
# What it does, in order:
#   1. builds `mari/base:v0`      — the base image (spec §2): `marid` + a POSIX
#      userland, and proves the built binary runs on this platform;
#   2. builds `mari/control-plane:v0` — the Node control plane + the web app;
#   3. creates the two named volumes (chunk store, Durable Object storage);
#   4. runs the control plane, and waits until it actually answers.
#
# Stop it with ./deploy/down.sh.
set -eu

# ---- locate the repo (this script's parent), regardless of cwd --------------
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$script_dir/.." && pwd)

PORT=${MARI_PORT:-8787}
BASE_IMAGE=${MARI_BASE_IMAGE:-mari/base:v0}
CP_IMAGE=${MARI_CP_IMAGE:-mari/control-plane:v0}
CONTAINER=${MARI_CONTAINER:-mari-control-plane}
STORE_VOLUME=${MARI_STORE_VOLUME:-mari-store}
DATA_VOLUME=${MARI_DATA_VOLUME:-mari-data}
DOCKER_SOCK=${MARI_DOCKER_SOCK:-/var/run/docker.sock}
MARI_HOME=${MARI_HOME:-$HOME/.mari}
SKIP_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=1 ;;
    -h|--help)
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "up.sh: unknown argument '$arg' (try --help)" >&2
      exit 2
      ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'mari: %s\n' "$*" >&2; exit 1; }

# ---- 0. preconditions -------------------------------------------------------
command -v docker >/dev/null 2>&1 ||
  die "no 'docker' on PATH. Install Docker Engine, Docker Desktop, Colima or Rancher Desktop."

docker version --format '{{.Server.Version}}' >/dev/null 2>&1 ||
  die "the Docker daemon is not reachable. Start it (Docker Desktop, 'colima start', …) and retry."

# ---- 1. the auth secret, generated once and kept ----------------------------
# It signs every session cookie, so it must survive a restart: a new secret
# would invalidate the passkey session you are about to create. Never printed.
if [ -n "${MARI_AUTH_SECRET:-}" ]; then
  auth_secret=$MARI_AUTH_SECRET
else
  secret_file="$MARI_HOME/auth-secret"
  if [ ! -s "$secret_file" ]; then
    mkdir -p "$MARI_HOME"
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -base64 32 >"$secret_file"
    else
      dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\n' >"$secret_file"
    fi
    chmod 600 "$secret_file"
    say "generated a session secret at $secret_file (keep it; it is not in the repo)"
  fi
  auth_secret=$(cat "$secret_file")
fi
[ -n "$auth_secret" ] || die "the session secret is empty; delete $MARI_HOME/auth-secret and retry."

# ---- 2. images --------------------------------------------------------------
if [ "$SKIP_BUILD" = 0 ]; then
  say "building the base image ($BASE_IMAGE) — first run compiles marid, so minutes not seconds"
  docker build -f "$repo/deploy/Dockerfile.marid" -t "$BASE_IMAGE" "$repo"

  # The image's entrypoint IS marid. Running its --help proves the binary exists
  # and is executable for this platform BEFORE any computer depends on it.
  docker run --rm "$BASE_IMAGE" --help >/dev/null ||
    die "$BASE_IMAGE was built but 'marid --help' failed inside it."

  say "building the control plane ($CP_IMAGE)"
  docker build -f "$repo/deploy/Dockerfile.control-plane" -t "$CP_IMAGE" "$repo"
else
  for img in "$BASE_IMAGE" "$CP_IMAGE"; do
    docker image inspect "$img" >/dev/null 2>&1 || die "--no-build, but $img is not built yet."
  done
fi

# ---- 3. volumes -------------------------------------------------------------
# The store volume is shared BY NAME with every computer: the control plane
# opens it as its object store while each container bind-mounts the same volume
# at /store. The chunk store is the home of the computer (spec §2) and both
# sides must see one home.
for vol in "$STORE_VOLUME" "$DATA_VOLUME"; do
  docker volume inspect "$vol" >/dev/null 2>&1 || docker volume create "$vol" >/dev/null
done

# ---- 4. run -----------------------------------------------------------------
if [ -n "$(docker ps -aq --filter "name=^${CONTAINER}$")" ]; then
  say "replacing the existing $CONTAINER container (volumes are kept)"
  docker rm -f "$CONTAINER" >/dev/null
fi

say "starting the control plane on http://localhost:$PORT"
# `--network bridge` is load-bearing, not incidental: computers are created as
# SIBLING containers through the mounted Docker socket, so they land on the
# default bridge network, and the control plane hands each one its own reachable
# address as MARI_CONTROL_URL. A user-defined network would be isolated from
# those siblings and no computer could dial home.
docker run -d \
  --name "$CONTAINER" \
  --network bridge \
  --restart unless-stopped \
  -p "$PORT:8787" \
  -v "$DOCKER_SOCK:/var/run/docker.sock" \
  -v "$DATA_VOLUME:/var/lib/mari/data" \
  -v "$STORE_VOLUME:/var/lib/mari/store" \
  -e PORT=8787 \
  -e MARI_BIND=0.0.0.0 \
  -e MARI_STORE_DIR=/var/lib/mari/store \
  -e MARI_STORE_HOST_DIR="$STORE_VOLUME" \
  -e MARI_STORE_MOUNT=/store \
  -e MARI_DATA_DIR=/var/lib/mari/data \
  -e MARI_COMPUTER_ROOT=/work \
  -e MARI_BASE_IMAGE="$BASE_IMAGE" \
  -e SUBSTRATE_MODE=docker \
  -e MARI_SUBSTRATES=docker \
  -e MARI_CONTROL_HOST="${MARI_CONTROL_HOST:-}" \
  -e AUTH_SECRET="$auth_secret" \
  -e BASE_URL="${MARI_BASE_URL:-http://localhost:$PORT}" \
  -e DEV_AUTH="${MARI_DEV_AUTH:-0}" \
  -e DEV_SEED="${MARI_DEV_SEED:-0}" \
  -e PREVIEW_ZONE="${MARI_PREVIEW_ZONE:-mari.sh}" \
  -e WARM_IDLE_MS="${MARI_WARM_IDLE_MS:-}" \
  -e COLD_IDLE_MS="${MARI_COLD_IDLE_MS:-}" \
  "$CP_IMAGE" >/dev/null

# ---- 5. wait for it to actually answer --------------------------------------
# A container that started is not an instance that works. Poll the published
# port — the same origin the browser will use — and show the logs on failure
# instead of printing a URL that 404s.
probe() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 -o /dev/null "http://localhost:$PORT/"
  else
    docker exec "$CONTAINER" node -e \
      'fetch("http://127.0.0.1:8787/").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'
  fi
}

i=0
until probe >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo >&2
    die "the control plane did not answer on http://localhost:$PORT within 60s. Last logs:
$(docker logs --tail 40 "$CONTAINER" 2>&1)"
  fi
  if [ -z "$(docker ps -q --filter "name=^${CONTAINER}$")" ]; then
    echo >&2
    die "the control plane exited. Logs:
$(docker logs --tail 40 "$CONTAINER" 2>&1)"
  fi
  printf '.'
  sleep 1
done
[ "$i" -gt 0 ] && echo

cat <<EOF

Mari is running.

  Open            http://localhost:$PORT
  Sign in         type an email, then "Create account with a passkey" (Touch ID,
                  Windows Hello, a security key — WebAuthn works on localhost).
                  Use localhost, not 127.0.0.1: the passkey is bound to the name.
  First computer  the fleet view is empty; press "New computer" (or Cmd+K →
                  "New computer"). It is created COLD, in the chunk store, and
                  costs nothing until you run something on it.
  First run       open the computer, then Cmd+K → "Run command" (or ⌥R).
                  The wake happens behind the interface.

  Logs            docker logs -f $CONTAINER
  Stop            ./deploy/down.sh
  Configuration   deploy/README.md
EOF
