// SPDX-License-Identifier: Apache-2.0
//! Per-viewer fanout state. Owners index viewers/encodes; payloads stay in their slab.
//! Pieces are copyable handles, not owned frame buffers. Queue storage is reserved once.
use std::collections::VecDeque;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Piece {
    pub sequence: u64,
    pub key: bool,
    pub bytes: usize,
}
#[derive(Clone, Copy, Debug)]
pub struct Window {
    pub frames: usize,
    pub bytes: usize,
}
impl Default for Window {
    fn default() -> Self {
        Self {
            frames: 60,
            bytes: 8 * 1024 * 1024,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Keyframe,
    Playing(bool),
    /// The transport accepted this piece. Refused attempts are never reported.
    Sent(Piece),
    Dropped,
}
#[derive(Debug)]
pub struct Viewer {
    window: Window,
    encode: Option<u64>,
    inflight: VecDeque<Piece>,
    inflight_bytes: usize,
    queue: VecDeque<Piece>,
    queued_bytes: usize,
    need_key: bool,
    dropping: bool,
    playing: bool,
}
impl Viewer {
    pub fn new(window: Window) -> Self {
        assert!(window.frames > 0);
        Self {
            window,
            encode: None,
            inflight: VecDeque::with_capacity(window.frames),
            inflight_bytes: 0,
            queue: VecDeque::with_capacity(window.frames),
            queued_bytes: 0,
            need_key: true,
            dropping: false,
            playing: false,
        }
    }
    pub fn assign(&mut self, encode: Option<u64>, mut event: impl FnMut(Event)) {
        if self.encode == encode {
            return;
        }
        self.encode = encode;
        self.clear_queue();
        self.need_key = true;
        self.dropping = false;
        if encode.is_some() {
            event(Event::Keyframe);
        } else if self.playing {
            self.playing = false;
            event(Event::Playing(false));
        }
    }
    pub fn stop(&mut self, mut event: impl FnMut(Event)) {
        self.encode = None;
        self.clear_queue();
        self.need_key = true;
        self.dropping = false;
        if self.playing {
            self.playing = false;
            event(Event::Playing(false));
        }
    }
    pub fn playing(&self) -> bool {
        self.playing
    }
    pub fn backlogged(&self) -> bool {
        !self.queue.is_empty() || self.dropping
    }
    fn clear_queue(&mut self) {
        self.queue.clear();
        self.queued_bytes = 0;
    }
    fn retain_key(&mut self) {
        if let Some(head) = self.queue.front().copied().filter(|p| p.key) {
            self.queue.truncate(1);
            self.queued_bytes = head.bytes;
        } else {
            self.clear_queue();
        }
    }
    pub fn keyframe(&mut self, mut event: impl FnMut(Event)) {
        if self.encode.is_none() {
            return;
        }
        self.need_key = true;
        self.retain_key();
        event(Event::Keyframe);
    }
    fn fits(&self, piece: Piece) -> bool {
        self.inflight.is_empty()
            || (self.inflight.len() < self.window.frames
                && self
                    .inflight_bytes
                    .checked_add(piece.bytes)
                    .is_some_and(|total| total <= self.window.bytes))
    }
    pub fn publish(
        &mut self,
        encode: u64,
        piece: Piece,
        send: impl FnMut(Piece) -> bool,
        mut event: impl FnMut(Event),
    ) {
        if self.encode != Some(encode) {
            return;
        }
        if piece.key {
            self.clear_queue();
            self.queue.push_back(piece);
            self.queued_bytes = piece.bytes;
            self.need_key = false;
            self.dropping = false;
        } else if self.need_key {
            return;
        } else if !self.queue.is_empty() || !self.fits(piece) {
            // Sizes near usize::MAX saturate the allowance and refuse the delta; nothing wraps.
            let allowance = self
                .window
                .bytes
                .saturating_add(self.queue.front().filter(|p| p.key).map_or(0, |p| p.bytes));
            if !self.queue.is_empty()
                && self.queue.len() < self.window.frames
                && self
                    .queued_bytes
                    .checked_add(piece.bytes)
                    .is_some_and(|total| total <= allowance)
            {
                self.queue.push_back(piece);
                self.queued_bytes += piece.bytes;
            } else {
                self.need_key = true;
                self.dropping = true;
                self.retain_key();
                event(Event::Dropped);
                event(Event::Keyframe);
            }
            return;
        } else {
            self.clear_queue();
            self.queue.push_back(piece);
            self.queued_bytes = piece.bytes;
        }
        self.flush(send, event);
    }
    pub fn acknowledge(
        &mut self,
        sequence: u64,
        send: impl FnMut(Piece) -> bool,
        event: impl FnMut(Event),
    ) {
        while self
            .inflight
            .front()
            .is_some_and(|p| p.sequence <= sequence)
        {
            if let Some(p) = self.inflight.pop_front() {
                self.inflight_bytes = self.inflight_bytes.saturating_sub(p.bytes);
            }
        }
        if self.encode.is_some() {
            self.flush(send, event);
        }
    }
    /// A transport reports acceptance synchronously. Apply cumulative acknowledgements after
    /// this call; unlike the TS callback, Rust's exclusive borrow prevents reentrant mutation.
    pub fn flush(&mut self, mut send: impl FnMut(Piece) -> bool, mut event: impl FnMut(Event)) {
        while let Some(piece) = self.queue.front().copied() {
            if !self.fits(piece) {
                return;
            }
            self.queue.pop_front();
            self.queued_bytes -= piece.bytes;
            self.inflight.push_back(piece);
            // `fits` bounded this, or the window was empty.
            self.inflight_bytes += piece.bytes;
            if !send(piece) {
                // Refused: back at the head of the queue with its bytes, as if never sent.
                self.inflight.pop_back();
                self.inflight_bytes -= piece.bytes;
                self.queue.push_front(piece);
                self.queued_bytes += piece.bytes;
                return;
            }
            // Only accepted pieces are reported, so a rate estimator never counts retries.
            event(Event::Sent(piece));
            if piece.key && !self.playing {
                self.playing = true;
                event(Event::Playing(true));
            }
        }
    }
}
