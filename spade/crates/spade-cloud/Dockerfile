# Spade Cloud (ADR 0140). Build from the `spade/` directory:
#   docker build -f crates/spade-cloud/Dockerfile -t spade-cloud .
# Configured only through the environment; see spade/docs/cloud.md.

FROM rust:1.95.0-slim-bookworm AS build
# The toolchain file also asks for clippy and rustfmt, which a release build doesn't need.
ENV RUSTUP_TOOLCHAIN=1.95.0 CARGO_TERM_COLOR=never
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p spade-cloud \
    && cp target/release/spade-cloud /spade-cloud

# glibc, libgcc and CA certificates only; runs as uid 65532.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /spade-cloud /usr/local/bin/spade-cloud
ENV PORT=8080
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/spade-cloud"]
