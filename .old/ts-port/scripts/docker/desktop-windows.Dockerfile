FROM node:24.13.1-bookworm

ARG BUN_VERSION=1.3.9

ENV CSC_IDENTITY_AUTO_DISCOVERY=false \
  DEBIAN_FRONTEND=noninteractive

RUN dpkg --add-architecture i386 \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    git \
    make \
    mono-runtime \
    nsis \
    pkg-config \
    python3 \
    wine \
    wine32:i386 \
    wine64 \
  && npm install --global "bun@${BUN_VERSION}" node-gyp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
