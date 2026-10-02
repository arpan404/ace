#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Python provides portable process deadlines on macOS and Linux; cleanup names only our resources.
exec python3 docker/run.py "$@"
