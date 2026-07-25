#!/bin/sh
# marid boot entrypoint: the timing run.
#
# The chunk store at /store was seeded AT IMAGE BUILD TIME with a snapshot of a
# reference tree (spec 2's "the fleet stores each base image once"), so nothing
# on this path does any work that a real cold wake would not do: the container
# starts, marid restores MARI_RESTORE_MANIFEST into MARI_ROOT, and then dials
# the control plane.
#
# Every line marid writes is timestamped into /tmp/probe/marid.log, and the
# instant its cold-wake restore lands is stamped into /tmp/probe/t_restored, so
# container-start -> restore-complete can be attributed from both clocks.
mkdir -p /tmp/probe 2>/dev/null
date +%s%3N > /tmp/probe/t_entry
echo ok > /tmp/probe/entry_ready

/usr/local/bin/marid 2>&1 | while IFS= read -r line; do
  ts=$(date +%s%3N)
  printf '%s %s\n' "$ts" "$line" >> /tmp/probe/marid.log
  case "$line" in
    *"cold-wake restore complete"*)
      [ -f /tmp/probe/t_restored ] || echo "$ts" > /tmp/probe/t_restored
      ;;
    *"agent adapters"*)
      [ -f /tmp/probe/t_adapters ] || echo "$ts" > /tmp/probe/t_adapters
      ;;
  esac
done

# marid exiting is itself a result; keep the container alive so it can be read.
echo "marid pipeline ended $(date +%s%3N)" >> /tmp/probe/marid.log
exec sleep 86400
