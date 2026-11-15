// SPDX-License-Identifier: Apache-2.0
//! Per-viewer fanout state. Owners index viewers/encodes; payloads stay in their slab.
//! Pieces are copyable handles, not owned frame buffers. Queue storage is reserved once.
//!
//! Matching video-fanout.ts: each change of encode starts a generation (a sequence space of its
//! own). Chunks on the wire stay in flight across it, the transport's debt, until an ack of
//! their generation, or of a later one sent after them, releases them, or `forget` does. No
//! debt lives for ever: a chunk unacked past the viewer's lifetime (its owner sets it from the
//! link; 2 s until then) is lost: freed, reported (`Event::Lost`) and a keyframe owed. Time is
//! passed in.
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
    /// Chunks went unacked past the viewer's lifetime: they are lost.
    Lost,
}
/// A chunk's lifetime in flight until its owner knows the link's round trip.
pub const DEFAULT_LIFETIME_MS: f64 = 2_000.0;
#[derive(Debug)]
pub struct Viewer {
    window: Window,
    encode: Option<u64>,
    generation: u64,
    /// Chunks on the wire in send order, with the generation that sent each and when.
    inflight: VecDeque<(Piece, u64, f64)>,
    lifetime: f64,
    inflight_bytes: usize,
    queue: VecDeque<Piece>,
    queued_bytes: usize,
    need_key: bool,
    dropping: bool,
    playing: bool,
    /// Bytes in flight its link carries in time (`LinkRate::backlog_bytes`); the window bounds it too.
    bound: Option<usize>,
}
impl Viewer {
    pub fn new(window: Window) -> Self {
        assert!(window.frames > 0);
        Self {
            window,
            encode: None,
            generation: 0,
            inflight: VecDeque::with_capacity(window.frames),
            lifetime: DEFAULT_LIFETIME_MS,
            inflight_bytes: 0,
            queue: VecDeque::with_capacity(window.frames),
            queued_bytes: 0,
            need_key: true,
            dropping: false,
            playing: false,
            bound: None,
        }
    }
    /// Holds bytes in flight to what the link carries in time, within the window (ADR 0149).
    pub fn bound(&mut self, bytes: Option<usize>) {
        self.bound = bytes;
    }
    fn bytes(&self) -> usize {
        self.bound
            .map_or(self.window.bytes, |b| b.min(self.window.bytes))
    }
    /// How long a chunk may go unacked before it is lost (`LinkRate::lifetime_ms`).
    pub fn set_lifetime(&mut self, ms: f64) {
        self.lifetime = ms;
    }
    /// Whether chunks of `generation` are still on the wire.
    pub fn owes(&self, generation: u64) -> bool {
        self.inflight.iter().any(|(_, g, _)| *g == generation)
    }
    fn expire(&mut self, now: f64, event: &mut impl FnMut(Event)) -> bool {
        let lost = self
            .inflight
            .iter()
            .take_while(|(_, _, at)| now - *at > self.lifetime)
            .count();
        if lost == 0 {
            return false;
        }
        for (p, _, _) in self.inflight.drain(..lost) {
            self.inflight_bytes = self.inflight_bytes.saturating_sub(p.bytes);
        }
        event(Event::Lost);
        self.dropping = true;
        // A keyframe already waiting starts the picture over; else deltas wait for one.
        if self.queue.front().is_some_and(|p| p.key) {
            return true;
        }
        self.clear_queue();
        self.need_key = true;
        if self.encode.is_some() {
            event(Event::Keyframe);
        }
        true
    }
    pub fn assign(&mut self, encode: Option<u64>, mut event: impl FnMut(Event)) {
        if self.encode == encode {
            return;
        }
        self.encode = encode;
        // Another sequence space; what is on the wire stays in flight.
        self.generation += 1;
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
        if self.encode.is_some() {
            self.generation += 1;
        }
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
                    .is_some_and(|total| total <= self.bytes()))
    }
    fn fits_window(&self, piece: Piece) -> bool {
        self.inflight.len() < self.window.frames
            && self
                .inflight_bytes
                .checked_add(piece.bytes)
                .is_some_and(|total| total <= self.window.bytes)
    }
    pub fn publish(
        &mut self,
        encode: u64,
        piece: Piece,
        now: f64,
        mut send: impl FnMut(Piece) -> bool,
        mut event: impl FnMut(Event),
    ) {
        // What a loss frees goes at once: a keyframe waiting behind lost chunks needn't wait on.
        if self.expire(now, &mut event) && self.encode.is_some() {
            self.send_queued(now, &mut send, &mut event);
        }
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
                .bytes()
                .saturating_add(self.queue.front().filter(|p| p.key).map_or(0, |p| p.bytes));
            // A delta only the time bound holds back (the window would take it) waits too.
            let waits = !self.queue.is_empty() || self.fits_window(piece);
            if waits
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
        self.send_queued(now, send, event);
    }
    /// The generation chunks are sent in now: an ack of them names it.
    pub fn generation(&self) -> u64 {
        self.generation
    }
    /// The viewer showed every chunk of `generation` up to `sequence`: it and everything sent
    /// before it are off the wire.
    pub fn acknowledge(
        &mut self,
        sequence: u64,
        generation: u64,
        now: f64,
        send: impl FnMut(Piece) -> bool,
        event: impl FnMut(Event),
    ) {
        let count = self
            .inflight
            .iter()
            .rposition(|(p, g, _)| *g == generation && p.sequence <= sequence)
            .map_or(0, |last| last + 1);
        self.release(count, now, send, event);
    }
    /// The viewer showed every chunk up to `sequence`, whatever generation sent it: for an owner
    /// whose sequences only increase across generations.
    pub fn acknowledge_through(
        &mut self,
        sequence: u64,
        now: f64,
        send: impl FnMut(Piece) -> bool,
        event: impl FnMut(Event),
    ) {
        let count = self
            .inflight
            .iter()
            .take_while(|(p, _, _)| p.sequence <= sequence)
            .count();
        self.release(count, now, send, event);
    }
    fn release(
        &mut self,
        count: usize,
        now: f64,
        send: impl FnMut(Piece) -> bool,
        mut event: impl FnMut(Event),
    ) {
        for (p, _, _) in self.inflight.drain(..count) {
            self.inflight_bytes = self.inflight_bytes.saturating_sub(p.bytes);
        }
        self.expire(now, &mut event);
        if self.encode.is_some() {
            self.send_queued(now, send, event);
        }
    }
    /// The transport confirms it dropped `generation`'s chunks: they are off the wire.
    pub fn forget(
        &mut self,
        generation: u64,
        now: f64,
        send: impl FnMut(Piece) -> bool,
        mut event: impl FnMut(Event),
    ) {
        let mut freed = 0_usize;
        self.inflight.retain(|(p, g, _)| {
            let keep = *g != generation;
            if !keep {
                freed = freed.saturating_add(p.bytes);
            }
            keep
        });
        self.inflight_bytes = self.inflight_bytes.saturating_sub(freed);
        self.expire(now, &mut event);
        if self.encode.is_some() {
            self.send_queued(now, send, event);
        }
    }
    /// Retries chunks the transport refused, and lets go of chunks lost past their lifetime.
    pub fn flush(
        &mut self,
        now: f64,
        send: impl FnMut(Piece) -> bool,
        mut event: impl FnMut(Event),
    ) {
        self.expire(now, &mut event);
        if self.encode.is_some() {
            self.send_queued(now, send, event);
        }
    }
    /// A transport reports acceptance synchronously. Apply cumulative acknowledgements after
    /// this call; unlike the TS callback, Rust's exclusive borrow prevents reentrant mutation.
    fn send_queued(
        &mut self,
        now: f64,
        mut send: impl FnMut(Piece) -> bool,
        mut event: impl FnMut(Event),
    ) {
        while let Some(piece) = self.queue.front().copied() {
            if !self.fits(piece) {
                return;
            }
            self.queue.pop_front();
            self.queued_bytes -= piece.bytes;
            self.inflight.push_back((piece, self.generation, now));
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
