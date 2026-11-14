// SPDX-License-Identifier: Apache-2.0
//! Picture size hysteresis. All times are caller-supplied monotonic milliseconds.
#[derive(Default, Debug)]
pub struct PictureScale {
    level: i32,
    started: bool,
    up_since: Option<f64>,
    down_since: Option<f64>,
}
fn scale_at(level: i32) -> f64 {
    0.84_f64.powi(level)
}
impl PictureScale {
    pub fn update(&mut self, link: f64, pixels: f64, fps: f64, now: f64) -> f64 {
        let carries = |level, spare| link >= pixels * scale_at(level).powi(2) * fps * 0.02 * spare;
        let fitting = |spare| {
            let mut level = 0;
            while level < 6 && !carries(level, spare) {
                level += 1;
            }
            level
        };
        if !self.started {
            self.started = true;
            self.level = fitting(1.0);
            return scale_at(self.level);
        }
        if self.level < 6 && !carries(self.level, 1.0) {
            self.up_since = None;
            let since = *self.down_since.get_or_insert(now);
            if now - since >= 1000.0 {
                self.level = fitting(1.0);
                self.down_since = None;
            }
            return scale_at(self.level);
        }
        self.down_since = None;
        let roomy = fitting(1.5);
        if roomy < self.level {
            let since = *self.up_since.get_or_insert(now);
            if now - since >= 3000.0 {
                self.level = roomy;
                self.up_since = None;
            }
        } else {
            self.up_since = None;
        }
        scale_at(self.level)
    }
}
