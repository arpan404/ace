FROM rust:1.91.1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb openbox dbus-x11 at-spi2-core libgtk-3-0 python3-gi python3-pil python3-xlib \
    libpipewire-0.3-dev libspa-0.2-dev pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY tests ./tests
COPY bench ./bench
RUN cargo check --locked --target x86_64-unknown-linux-gnu && cargo test --locked \
    && cargo build --locked --release --examples --bins
COPY docker ./docker
RUN mkdir -p /tmp/ace-runtime && chmod 700 /tmp/ace-runtime
ENV DISPLAY=:99 GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0 XDG_RUNTIME_DIR=/tmp/ace-runtime
ENTRYPOINT ["dbus-run-session", "--", "python3", "docker/integration.py"]
