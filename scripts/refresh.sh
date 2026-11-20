#!/usr/bin/env sh
cd "$(dirname "$0")/.."
node bin/pmctl.mjs audit "$@" --fresh
