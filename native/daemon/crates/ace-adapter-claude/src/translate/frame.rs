// SPDX-License-Identifier: Apache-2.0
//! Frame views for translation (the shared shape of `Frame` the translator
//! reads: sequence, direction, channel, redacted data and admitted bytes).

use ace_json::Value;

pub struct FrameView<'a> {
    pub seq: i64,
    pub dir: &'a str,
    pub channel: &'a str,
    pub data: &'a Value,
    pub payload_bytes: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct OwnedFrame {
    pub seq: i64,
    pub dir: String,
    pub channel: String,
    pub data: Value,
    pub payload_bytes: Option<usize>,
}

impl OwnedFrame {
    pub fn view(&self) -> FrameView<'_> {
        FrameView {
            seq: self.seq,
            dir: &self.dir,
            channel: &self.channel,
            data: &self.data,
            payload_bytes: self.payload_bytes,
        }
    }
}
