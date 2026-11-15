// SPDX-License-Identifier: Apache-2.0
//! Frame-size feedback for constant-frame-rate encoding.
#[derive(Debug)]
pub struct QuantizerControl {
    quantizer: f64,
    average: Option<f64>,
    since_change: usize,
    bits_per_frame: f64,
    bitrate: f64,
    last: f64,
    key_quantizer: Option<f64>,
    key_bits: Option<f64>,
}
// JavaScript Math.round rounds negative ties toward positive infinity.
fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}
pub fn affords_settle_key(bits: Option<f64>, bitrate: f64) -> bool {
    bits.is_some_and(|bits| bits <= bitrate * 0.5)
}
impl QuantizerControl {
    pub fn new(bitrate: f64, fps: f64) -> Self {
        Self {
            quantizer: 36.0,
            average: None,
            since_change: 0,
            bits_per_frame: bitrate / fps,
            bitrate,
            last: 36.0,
            key_quantizer: None,
            key_bits: None,
        }
    }
    pub fn retarget(&mut self, bitrate: f64, fps: f64) {
        self.bits_per_frame = bitrate / fps;
        self.bitrate = bitrate;
    }
    pub fn next(&mut self, key: bool) -> f64 {
        let q = (self.quantizer + if key { 6.0 } else { 0.0 }).min(51.0);
        self.last = q;
        if key {
            self.key_quantizer = Some(q);
        }
        q
    }
    pub fn settled(&mut self) -> Option<f64> {
        let q = round(self.key_quantizer? - 6.0 * (self.bitrate * 0.5 / self.key_bits?).log2())
            .max(18.0);
        if q >= self.last {
            return None;
        }
        self.last = q;
        self.key_quantizer = Some(q);
        self.key_bits = None;
        Some(q)
    }
    pub fn observe(&mut self, bytes: usize, key: bool) {
        let bits = bytes as f64 * 8.0;
        if key {
            self.key_bits = Some(bits);
            return;
        }
        let avg = self.average.map_or(bits, |avg| avg + (bits - avg) * 0.25);
        self.average = Some(avg);
        self.since_change += 1;
        if self.since_change < 3 {
            return;
        }
        let step = round(3.0 * (avg / self.bits_per_frame).log2());
        if step == 0.0 {
            return;
        }
        self.quantizer = (self.quantizer + step.clamp(-2.0, 4.0)).clamp(18.0, 51.0);
        self.since_change = 0;
    }
}
