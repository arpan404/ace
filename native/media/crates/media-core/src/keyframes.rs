// SPDX-License-Identifier: Apache-2.0
//! Encoder pacing and coalesced picture key requests; times are injected milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Skip,
    Delta,
    Key,
}
#[derive(Debug)]
pub struct EncodePacer {
    fps: f64,
    next_at: f64,
    last_key: f64,
    owed: bool,
    last_encode: f64,
    settled: bool,
    skipped: bool,
}
impl EncodePacer {
    pub fn new(fps: f64) -> Self {
        Self {
            fps,
            next_at: f64::NEG_INFINITY,
            last_key: f64::NEG_INFINITY,
            owed: true,
            last_encode: f64::NEG_INFINITY,
            settled: true,
            skipped: false,
        }
    }
    pub fn request_keyframe(&mut self) {
        self.owed = true;
    }
    pub fn frame(&mut self, now: f64, busy: bool) -> Decision {
        if busy {
            self.skipped = true;
            return Decision::Skip;
        }
        if self.key_due(now) {
            return self.encoded(now, true);
        }
        if now < self.next_at - 8.0 {
            self.skipped = true;
            return Decision::Skip;
        }
        self.encoded(now, false)
    }
    pub fn catch_up(&mut self, now: f64, busy: bool) -> bool {
        if !self.skipped || busy || now < self.next_at - 8.0 {
            return false;
        }
        self.encoded(now, false);
        true
    }
    pub fn still(&mut self, now: f64, last_frame_at: f64, busy: bool) -> bool {
        if busy || now - last_frame_at < 100.0 || !self.key_due(now) {
            return false;
        }
        self.encoded(now, true);
        true
    }
    pub fn settle(&mut self, now: f64, last_frame_at: f64, idle: bool) -> bool {
        if !idle || self.settled || self.key_due(now) {
            return false;
        }
        if now - last_frame_at < 300.0 || now - self.last_encode < 300.0 {
            return false;
        }
        self.settled = true;
        self.skipped = false;
        self.last_encode = now;
        self.next_at = self.next_at.max(now + 1000.0 / self.fps - 8.0);
        true
    }
    fn key_due(&self, now: f64) -> bool {
        now - self.last_key >= 20_000.0 || (self.owed && now - self.last_key >= 500.0)
    }
    fn encoded(&mut self, now: f64, key: bool) -> Decision {
        let interval = 1000.0 / self.fps;
        self.next_at = (self.next_at + interval).max(now + interval - 8.0);
        self.last_encode = now;
        self.settled = false;
        self.skipped = false;
        if !key {
            return Decision::Delta;
        }
        self.last_key = now;
        self.owed = false;
        Decision::Key
    }
}
/// Shell requests once at the returned deadline; repeated requests cannot postpone it.
#[derive(Debug)]
pub struct PictureKeyframes {
    last: f64,
    pending: bool,
}
impl Default for PictureKeyframes {
    fn default() -> Self {
        Self {
            last: f64::NEG_INFINITY,
            pending: false,
        }
    }
}
impl PictureKeyframes {
    pub fn request(&mut self, now: f64) -> Option<f64> {
        if self.pending {
            return None;
        }
        self.pending = true;
        Some((self.last + 500.0).max(now))
    }
    pub fn poll(&mut self, now: f64) -> bool {
        if !self.pending || now < self.last + 500.0 {
            return false;
        }
        self.pending = false;
        self.last = now;
        true
    }
}
