#!/bin/sh
# Idle entrypoint for the probe container.
#
# ctx.container.exec() cannot start a stopped container, so the image needs a
# process that outlives the start() call and does nothing. It also stamps the
# instant the entrypoint got control, which is what lets the Durable Object
# split "container start" from "work the container did".
mkdir -p /tmp/probe 2>/dev/null
date +%s%3N > /tmp/probe/t_entry
echo ok > /tmp/probe/entry_ready
exec sleep 86400
