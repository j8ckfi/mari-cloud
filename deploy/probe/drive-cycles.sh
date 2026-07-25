#!/bin/sh
# Drive N destroy -> start -> exec-ready cycles from OUTSIDE the Worker, with
# short requests, so an edge response timeout cannot truncate the measurement.
#
# Timing is the local clock plus one edge round trip per poll (~50-150 ms), so
# every number below is an upper bound. That is fine: the quantities of interest
# are seconds.
#
#   PROBE_URL=... PROBE_TOKEN=... ./drive-cycles.sh 5
set -eu

URL="${PROBE_URL:?set PROBE_URL}"
TOK="${PROBE_TOKEN:?set PROBE_TOKEN}"
N="${1:-3}"

get() { curl -s --max-time 60 -H "x-probe-token: $TOK" "$URL$1"; }
post() { curl -s --max-time 60 -H "x-probe-token: $TOK" -X POST "$URL$1"; }

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

i=0
while [ "$i" -lt "$N" ]; do
  i=$((i + 1))
  echo "===== cycle $i ====="

  # Marker on the container's disk: it must not survive the restart.
  post "/exec" >/dev/null 2>&1 || true
  curl -s --max-time 60 -H "x-probe-token: $TOK" -X POST "$URL/exec" \
    -d '{"argv":["/bin/sh","-c","echo marker > /work/EPHEMERAL-MARKER; ls /work"]}' \
    | tr -d '\n' | sed 's/  */ /g'; echo

  t0=$(now_ms)
  echo "destroy: $(post /destroy-async | tr -d '\n' | sed 's/  */ /g')"
  # Poll until the platform reports the instance gone.
  while :; do
    r=$(get /status)
    case "$r" in *false*) break ;; esac
    sleep 1
    t=$(now_ms)
    if [ $((t - t0)) -gt 300000 ]; then echo "STOP TIMEOUT"; break; fi
  done
  t1=$(now_ms)
  echo "destroy_to_stopped_ms=$((t1 - t0))"

  # Start, then poll exec until the sandbox can run a process.
  t2=$(now_ms)
  echo "start: $(post '/start-async' | tr -d '\n' | sed 's/  */ /g')"
  while :; do
    r=$(post /ping)
    case "$r" in *'"ok": true'*) break ;; esac
    t=$(now_ms)
    if [ $((t - t2)) -gt 180000 ]; then echo "START TIMEOUT: $r"; break; fi
  done
  t3=$(now_ms)
  echo "start_to_exec_ready_ms=$((t3 - t2))"

  curl -s --max-time 60 -H "x-probe-token: $TOK" -X POST "$URL/exec" \
    -d '{"argv":["/bin/sh","-c","if [ -e /work/EPHEMERAL-MARKER ]; then echo DISK_SURVIVED; else echo DISK_GONE; fi; ls -a /work | tr \"\\n\" \" \""]}' \
    | tr -d '\n' | sed 's/  */ /g'; echo
done
