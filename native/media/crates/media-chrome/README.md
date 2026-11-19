# media-chrome

ace-media's last-resort encoder: a headless Chrome for Testing that ace-media starts itself
and encodes H.264 with through WebCodecs' software encoder. It's only for machines with no
hardware encoder, such as VMs. How it works and what it measured are in
[docs/media/plan.md, "B4 notes"](../../../../docs/media/plan.md#b4-notes).

- `ChromeEncoder` implements `media_codec::Encoder` and reports `hardware: false`.
- `find_chrome` looks for Chrome the way the daemon does.
- `probe` runs the bounded availability trial, and `last_resort_needed` keeps this encoder out
  when another backend has a working hardware encoder.

## Tests

- `cargo test -p media-chrome` runs the unit tests and `tests/contract.rs`. The contract tests
  drive a fake browser (this test binary, started through a script) that speaks Chrome's side
  of the pipe and the page protocol, so they need no Chrome.
- `tests/chrome.rs` encodes through a real headless Chrome. It skips, and says so, when no
  Chrome is found. Set `ACE_CHROMIUM_PATH` to choose one.

## Bench

```sh
cargo run --release -p media-chrome --example encode -- --size 1920x1080 --fps 30 --input jpeg
```

It reports frames out, latency, and CPU for Chrome's process tree and for the calling process.
