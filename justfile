set dotenv-load

default:
    just --list

desktop-dev:
    ./desktop:dev

desktop-watch:
    ./desktop:watch

check:
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    cargo test --workspace --all-targets
    cargo check --workspace
