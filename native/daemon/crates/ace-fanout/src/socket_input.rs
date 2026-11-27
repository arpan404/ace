// SPDX-License-Identifier: Apache-2.0
//! Per-socket input backpressure and serialization policy (`apps/daemon/src/socket-input.ts`).
//!
//! A socket whose handlers fall behind is paused so TCP backpressure reaches the peer, and
//! resumes once its queue drains to half the pause threshold. Last-resort per-socket and global
//! byte caps close with `4009 "Message backpressure"`. Immediate frames (e.g. heartbeats/pings)
//! bypass the queue so a slow handler cannot break liveness.

use std::collections::HashMap;
use std::hash::Hash;

/// Close code when inbound message backpressure exceeds last-resort caps.
pub const INPUT_BACKPRESSURE_CLOSE_CODE: u16 = 4009;
pub const INPUT_BACKPRESSURE_CLOSE_REASON: &str = "Message backpressure";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SocketInputLimits {
    /// Stop reading a socket once this many of its messages wait for a handler.
    pub pause_messages: usize,
    /// ...or once its waiting input reaches this many charged bytes.
    pub pause_bytes: usize,
    /// Last resort per socket.
    pub socket_bytes: usize,
    /// Last resort across every socket.
    pub global_bytes: usize,
    /// Charged per message on top of its payload, so tiny frames still count.
    pub message_overhead: usize,
}

impl Default for SocketInputLimits {
    fn default() -> Self {
        Self {
            pause_messages: 16,
            pause_bytes: 1024 * 1024,
            socket_bytes: 8 * 1024 * 1024,
            global_bytes: 16 * 1024 * 1024,
            message_overhead: 256,
        }
    }
}

/// Decision for one inbound frame arriving on a socket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputDecision {
    /// Handle immediately without queuing or pausing (e.g., liveness `ping`).
    Immediate,
    /// Queue behind earlier handlers; `pause == true` asks the shell to pause socket reads.
    Queue { charge: usize, pause: bool },
    /// Exceeded per-socket or global last-resort byte cap; close the socket with `code`/`reason`.
    Close { code: u16, reason: &'static str },
}

#[derive(Clone, Copy, Debug, Default)]
struct PerSocket {
    queued: usize,
    bytes: usize,
    paused: bool,
}

/// Tracks queued inbound messages and byte charges across every main socket.
#[derive(Clone, Debug)]
pub struct SocketInput<K> {
    limits: SocketInputLimits,
    global_bytes: usize,
    global_queued: usize,
    sockets: HashMap<K, PerSocket>,
}

impl<K: Eq + Hash> SocketInput<K> {
    pub fn new(limits: SocketInputLimits) -> Self {
        Self {
            limits,
            global_bytes: 0,
            global_queued: 0,
            sockets: HashMap::new(),
        }
    }

    pub fn depth(&self) -> usize {
        self.global_queued
    }

    pub fn global_bytes(&self) -> usize {
        self.global_bytes
    }

    pub fn is_paused(&self, socket: &K) -> bool {
        self.sockets.get(socket).is_some_and(|s| s.paused)
    }

    /// Admit an inbound frame of `payload_bytes` on `socket`. `immediate` frames are checked
    /// against the last-resort byte caps first (matching `socket-input.ts:61-67`) and then
    /// answered immediately without queuing.
    pub fn admit(&mut self, socket: K, payload_bytes: usize, immediate: bool) -> InputDecision {
        let charge = payload_bytes.saturating_add(self.limits.message_overhead);
        let entry = self.sockets.entry(socket).or_default();
        if entry.bytes.saturating_add(charge) > self.limits.socket_bytes
            || self.global_bytes.saturating_add(charge) > self.limits.global_bytes
        {
            return InputDecision::Close {
                code: INPUT_BACKPRESSURE_CLOSE_CODE,
                reason: INPUT_BACKPRESSURE_CLOSE_REASON,
            };
        }
        if immediate {
            return InputDecision::Immediate;
        }
        entry.queued += 1;
        entry.bytes += charge;
        self.global_queued += 1;
        self.global_bytes += charge;
        let backlogged =
            entry.queued >= self.limits.pause_messages || entry.bytes >= self.limits.pause_bytes;
        let pause = backlogged && !entry.paused;
        if pause {
            entry.paused = true;
        }
        InputDecision::Queue { charge, pause }
    }

    /// Mark a queued frame (with its `charge`) as finished. Returns `true` if the socket should
    /// resume reading now.
    pub fn finish(&mut self, socket: &K, charge: usize) -> bool {
        let Some(entry) = self.sockets.get_mut(socket) else {
            return false;
        };
        entry.queued = entry.queued.saturating_sub(1);
        entry.bytes = entry.bytes.saturating_sub(charge);
        self.global_queued = self.global_queued.saturating_sub(1);
        self.global_bytes = self.global_bytes.saturating_sub(charge);
        if entry.paused
            && entry.queued <= self.limits.pause_messages / 2
            && entry.bytes <= self.limits.pause_bytes / 2
        {
            entry.paused = false;
            return true;
        }
        false
    }

    /// Drop tracking for a closed socket once its handlers have drained (or immediately if none
    /// are running).
    pub fn remove(&mut self, socket: &K) {
        if let Some(entry) = self.sockets.remove(socket) {
            self.global_queued = self.global_queued.saturating_sub(entry.queued);
            self.global_bytes = self.global_bytes.saturating_sub(entry.bytes);
        }
    }
}
