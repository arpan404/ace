// SPDX-License-Identifier: Apache-2.0
//! Screen/device request budgets, matching devices/stream-profile.ts.
use crate::device_control::{Codec, StreamSettings};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Connection {
    Local,
    Remote,
    Relay,
}
fn profile(
    panel: (f64, f64),
    connection: Connection,
    pressure: f64,
    budget: (f64, f64, f64),
) -> StreamSettings {
    let level = pressure.clamp(0.0, 3.0);
    let shrink = if level >= 3.0 && connection != Connection::Local {
        0.75
    } else {
        1.0
    };
    let bucket = |v: f64, limit: f64| {
        ((v.min(limit) * shrink / 64.0).ceil() * 64.0)
            .max(64.0)
            .min(limit) as u32
    };
    StreamSettings {
        codec: Codec::H264,
        max_width: bucket(panel.0, budget.0),
        max_height: bucket(panel.1, budget.1),
        fps: 60,
        bitrate: (budget.2 / (1.0 + level * 0.5)).round().max(1_000_000.0) as u32,
    }
}
pub fn device_stream_profile(
    panel: (f64, f64),
    connection: Connection,
    pressure: f64,
) -> StreamSettings {
    let budget = match connection {
        Connection::Local => (3840.0, 3840.0, 12_000_000.0),
        Connection::Remote => (1440.0, 2880.0, 8_000_000.0),
        Connection::Relay => (1080.0, 2160.0, 5_000_000.0),
    };
    profile(panel, connection, pressure, budget)
}
pub fn screen_stream_profile(
    panel: (f64, f64),
    connection: Connection,
    pressure: f64,
) -> StreamSettings {
    let budget = match connection {
        Connection::Local => (3840.0, 3840.0, 16_000_000.0),
        Connection::Remote => (2560.0, 2560.0, 10_000_000.0),
        Connection::Relay => (1920.0, 1920.0, 6_000_000.0),
    };
    profile(panel, connection, pressure, budget)
}
