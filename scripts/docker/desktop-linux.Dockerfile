FROM node:24.13.1-bookworm

ARG BUN_VERSION=1.3.9

ENV APPIMAGE_EXTRACT_AND_RUN=1 \
  DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fakeroot \
    file \
    g++ \
    git \
    libarchive-tools \
    libfuse2 \
    make \
    pkg-config \
    python3 \
    rpm \
    xz-utils \
  && npm install --global "bun@${BUN_VERSION}" node-gyp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
