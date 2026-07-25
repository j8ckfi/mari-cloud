# SCRATCH — Gate 2 probe image (mari-probe-net). Delete with the directory.
#
# No RUN steps on purpose: the image is pure COPY on top of an official
# linux/amd64 base, so it builds on an arm64 host without qemu emulation, and
# nothing but CPython's stdlib is under test.
FROM --platform=linux/amd64 python:3.12-slim-bookworm

WORKDIR /probe
COPY probe.py /probe/probe.py
COPY fixtures /probe/fixtures

ENV PYTHONUNBUFFERED=1 \
    PROBE_FIXTURES=/probe/fixtures

EXPOSE 8080
ENTRYPOINT ["python3", "/probe/probe.py"]
