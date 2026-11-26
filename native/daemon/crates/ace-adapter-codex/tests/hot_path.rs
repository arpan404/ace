// SPDX-License-Identifier: Apache-2.0
//! The Codex peer's hot path over a recorded session (`fixtures/codex`): one
//! parse per line, one classify, the effects the frame decided. It is a
//! measurement, not a test of behaviour, so it only runs when asked:
//!
//! ```sh
//! cargo test -p ace-adapter-codex --test hot_path -- --ignored --nocapture
//! ```

use std::time::Instant;

use ace_json::Value;
use ace_supervisor::peer::{PeerConfig, RpcPeer};

/// The recorded session's received frames, already decoded once, as the wire
/// text the peer sees.
fn recorded_frames() -> Vec<String> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../fixtures/codex/0.159.1/plan-review.jsonl"
    );
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => panic!("the Codex recording is in the repository: {error}"),
    };
    let mut frames = Vec::new();
    for line in text.lines() {
        let Ok(value) = ace_json::parse(line) else {
            continue;
        };
        if value.get("dir").and_then(Value::as_str) != Some("recv") {
            continue;
        }
        if let Some(data) = value.get("data") {
            frames.push(ace_json::to_string(data));
        }
    }
    frames
}

#[test]
#[ignore = "measurement over a recorded fixture; run with --ignored --nocapture"]
fn the_peer_hot_path_over_a_recorded_codex_session() {
    let frames = recorded_frames();
    assert!(
        frames.len() > 100,
        "the fixture holds a session: {}",
        frames.len()
    );
    let rounds = 20;
    let started = Instant::now();
    let mut effects = 0usize;
    for _ in 0..rounds {
        let mut peer = RpcPeer::new(PeerConfig::default());
        for frame in &frames {
            effects += peer.line(frame).len();
        }
    }
    let elapsed = started.elapsed();
    let total = rounds * frames.len();
    let per_frame = elapsed.as_secs_f64() * 1_000_000.0 / total as f64;
    eprintln!(
        "codex hot path: {total} frames, {per_frame:.2} us/frame, {effects} effects, {:.0} frames/s",
        total as f64 / elapsed.as_secs_f64()
    );
    // A regression guard with room for a loaded machine; the printed number is
    // the measurement.
    assert!(per_frame < 2_000.0, "{per_frame} us/frame");
}
