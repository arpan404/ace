// SPDX-License-Identifier: Apache-2.0
//! Per-viewer fanout state. Owners index viewers/encodes; payloads stay in their slab.
//! Pieces are copyable handles, not owned frame buffers. Queue storage is reserved once.
//!
//! Matching video-fanout.ts: each change of encode starts a generation (a sequence space of its
//! own). Chunks on the wire stay in flight across it, the transport's debt, until an ack of
//! their generation, or of a later one sent after them, releases them, or `forget` does. No
//! debt lives for ever, but on TCP a chunk is delayed, never lost, so this is a liveness guard
//! that must not fire on a healthy link: each chunk is due by its send time, plus the bytes in
//! flight up to it at the relay's floor rate, two round trips and a second (`deadline`). Past
//! it, the chunk is lost: freed, reported (`Event::Lost`) and a keyframe owed. Time is passed in.
//!
//! A view that stops acking is not asked for keyframes for ever, and is not sent pictures it will
//! not take: one that acked before and then went silent past `PARK_AFTER_MS` is parked (nothing
//! in flight or queued, no keyframe owed) until an ack or a keyframe request starts it again at a
//! fresh keyframe; one that has never acked is asked for at most `UNANSWERED_LIMIT` keyframes and
//! then left to whatever its source makes on its own.
use crate::link_rate::{LINK_FLOOR, UNKNOWN_ROUND_TRIP_MS};
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
    /// Chunks went unacked past their deadline: they are lost.
    Lost,
}

const DEADLINE_SLACK_MS: f64 = 1_000.0;
/// How long a view may go without an ack while chunks of it sit past their deadline before it is
/// parked: a page hidden for a while, a decoder that stopped answering, a client that went away.
/// A live view acks every picture, so this only fires on one that stopped taking them.
const PARK_AFTER_MS: f64 = 2_000.0;
/// How many keyframes are asked of a source for a view that has never acked before it is clear
/// it takes none: a client that has shown no picture is not asked for ever.
const UNANSWERED_LIMIT: u8 = 3;
/// When a chunk sent `at`, with `bytes` in flight up to and including it, is due: those bytes
/// at the relay's floor rate (never the current rate), two round trips and a second.
pub fn deadline(at: f64, bytes: usize, round_trip: Option<f64>) -> f64 {
    at + bytes as f64 * 8.0 * 1000.0 / LINK_FLOOR
        + 2.0 * round_trip.unwrap_or(UNKNOWN_ROUND_TRIP_MS)
        + DEADLINE_SLACK_MS
}
#[derive(Debug)]
pub struct Viewer {
    window: Window,
    encode: Option<u64>,
    generation: u64,
    /// Chunks on the wire in send order, with the generation that sent each and its deadline.
    inflight: VecDeque<(Piece, u64, f64)>,
    round_trip: Option<f64>,
    inflight_bytes: usize,
    queue: VecDeque<Piece>,
    queued_bytes: usize,
    need_key: bool,
    dropping: bool,
    playing: bool,
    /// Bytes in flight its link carries in time (`LinkRate::backlog_bytes`); the window bounds it too.
    bound: Option<usize>,
    /// When it last acknowledged a chunk; absent until its first. A view that stops acking is
    /// what `parked` and `unanswered` decide about.
    last_ack: Option<f64>,
    /// Sending stopped: nothing is in flight, nothing queued, and its source is asked for
    /// nothing. An ack (or a client's keyframe request) starts it again at a fresh keyframe.
    parked: bool,
    /// Automatic keyframe requests made since it last acked: a view that never does is asked
    /// only so many times.
    unanswered: u8,
    /// It asked for its limit of keyframes without a single ack: what the source makes still
    /// reaches it, but its source is asked for nothing more.
    stalled: bool,
}
impl Viewer {
    pub fn new(window: Window) -> Self {
        assert!(window.frames > 0);
        Self {
            window,
            encode: None,
            generation: 0,
            inflight: VecDeque::with_capacity(window.frames),
            round_trip: None,
            inflight_bytes: 0,
            queue: VecDeque::with_capacity(window.frames),
            queued_bytes: 0,
            need_key: true,
            dropping: false,
            playing: false,
            bound: None,
            last_ack: None,
            unanswered: 0,
            parked: false,
            stalled: false,
        }
    }
    /// Whether it stopped sending for want of acks.
    pub fn parked(&self) -> bool {
        self.parked
    }
    /// Asks its source for a keyframe: once per deficit, up to the limit, while it acks nothing.
    fn ask_key(&mut self, mut event: impl FnMut(Event)) {
        if self.encode.is_none() || self.stalled {
            return;
        }
        if self.last_ack.is_none() {
            if self.unanswered >= UNANSWERED_LIMIT {
                self.stalled = true;
                return;
            }
            self.unanswered += 1;
        }
        event(Event::Keyframe);
    }
    /// Stops it: nothing in flight, nothing queued, and no keyframe owed. What it missed is not
    /// asked of its source: a view that acks nothing would only miss that too.
    fn park(&mut self) {
        self.parked = true;
        self.inflight.clear();
        self.inflight_bytes = 0;
        self.clear_queue();
        self.need_key = false;
        self.dropping = false;
    }
    /// Holds bytes in flight to what the link carries in time, within the window (ADR 0149).
    pub fn bound(&mut self, bytes: Option<usize>) {
        self.bound = bytes;
    }
    fn bytes(&self) -> usize {
        self.bound
            .map_or(self.window.bytes, |b| b.min(self.window.bytes))
    }
    /// The link's round trip now (`LinkRate::rtt`): chunks sent from now are due by it.
    pub fn set_round_trip(&mut self, ms: Option<f64>) {
        self.round_trip = ms;
    }
    /// When the earliest chunk in flight (its head: deadlines only grow) is due.
    pub fn next_deadline(&self) -> Option<f64> {
        self.inflight.front().map(|(_, _, due)| *due)
    }
    /// Whether chunks of `generation` are still on the wire.
    pub fn owes(&self, generation: u64) -> bool {
        self.inflight.iter().any(|(_, g, _)| *g == generation)
    }
    fn expire(&mut self, now: f64, event: &mut impl FnMut(Event)) -> bool {
        if self.parked {
            return false;
        }
        let lost = self
            .inflight
            .iter()
            .take_while(|(_, _, due)| now > *due)
            .count();
        if lost == 0 {
            return false;
        }
        for (p, _, _) in self.inflight.drain(..lost) {
            self.inflight_bytes = self.inflight_bytes.saturating_sub(p.bytes);
        }
        event(Event::Lost);
        // A view that acked once and then stopped is not taking pictures any more: park it,
        // rather than ask its source for keyframes it would never take.
        if self.last_ack.is_some_and(|at| now - at >= PARK_AFTER_MS) {
            self.park();
            return true;
        }
        self.dropping = true;
        // A keyframe already waiting starts the picture over; else deltas wait for one.
        if self.queue.front().is_some_and(|p| p.key) {
            return true;
        }
        self.clear_queue();
        self.need_key = true;
        self.ask_key(event);
        true
    }
    pub fn assign(&mut self, encode: Option<u64>, mut event: impl FnMut(Event)) {
        if self.encode == encode {
            return;
        }
        self.parked = false;
        self.stalled = false;
        self.unanswered = 0;
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
        self.parked = false;
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
    /// Holds the bytes in flight to `bytes` from now on (its link's budget). A lone piece always
    /// goes when nothing is in flight, so a keyframe larger than the budget still passes.
    pub fn limit_bytes(&mut self, bytes: usize) {
        self.window.bytes = bytes.max(1);
    }
    /// Whether a piece is still queued here, waiting for room: its payload must be kept.
    pub fn queued(&self, sequence: u64) -> bool {
        self.queue.iter().any(|p| p.sequence == sequence)
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
        // A client asking for a keyframe is alive: whatever it missed, it takes pictures again.
        self.parked = false;
        self.stalled = false;
        self.unanswered = 0;
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
        if self.parked {
            return;
        }
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
                self.ask_key(event);
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
        self.last_ack = Some(now);
        self.stalled = false;
        self.unanswered = 0;
        let parked = self.parked;
        self.parked = false;
        for (p, _, _) in self.inflight.drain(..count) {
            self.inflight_bytes = self.inflight_bytes.saturating_sub(p.bytes);
        }
        self.expire(now, &mut event);
        if self.encode.is_some() {
            self.send_queued(now, send, &mut event);
        }
        // Parked and back: whatever it missed is gone, so it starts again at a fresh keyframe.
        if parked {
            self.keyframe(&mut event);
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
            // Never before the chunk ahead of it: the transport is ordered, so deadlines only
            // grow along the window, and expiry need only look at its head.
            let due = deadline(
                now,
                self.inflight_bytes.saturating_add(piece.bytes),
                self.round_trip,
            )
            .max(
                self.inflight
                    .back()
                    .map_or(f64::NEG_INFINITY, |(_, _, due)| *due),
            );
            self.inflight.push_back((piece, self.generation, due));
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
