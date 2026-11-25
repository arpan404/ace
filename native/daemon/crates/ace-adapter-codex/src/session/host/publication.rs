// SPDX-License-Identifier: Apache-2.0
//! The host's ordered publication: every effect an input decides waits in one
//! queue, and one caller at a time hands it to the shell. Two inputs never
//! swap the effects they decided, so a settlement a timer decided is never
//! published after the exit a pipe close decided later (`bridge.rs`'s ordered
//! publication, ADR 0223 §7 rule 3).

use super::*;

/// The effects one host decided, waiting for the shell in decision order.
///
/// An input's effects join the queue while the host still holds its lock, so
/// the queue's order is the order in which the host decided them. Exactly one
/// caller drains it at a time, and a decision made while the drain runs (a
/// write acknowledged, a stop answered) joins the queue and follows the
/// effects already decided.
#[derive(Default)]
pub(super) struct Publication {
    queue: VecDeque<Queued>,
    /// Set once the shell has given the host its sink.
    sink: Option<Arc<dyn HostSink>>,
    publishing: bool,
    /// Frames waiting, and the bytes they hold: what the gate watches.
    frames: usize,
    bytes: usize,
    /// The gate is closed because of this backlog.
    paced: bool,
}

impl Publication {
    /// Queues one effect, counting the frame it holds.
    fn hold(&mut self, effect: HostEffect, bytes: usize) {
        if matches!(effect, HostEffect::Frame { .. }) {
            self.frames += 1;
            self.bytes += bytes;
        }
        self.queue.push_back(Queued { effect, bytes });
    }

    /// The effect left the queue: its reservation goes with it.
    fn release(&mut self, queued: &Queued) {
        if matches!(queued.effect, HostEffect::Frame { .. }) {
            self.frames = self.frames.saturating_sub(1);
            self.bytes = self.bytes.saturating_sub(queued.bytes);
        }
    }
}

/// One effect waiting for the shell, with what its frame reserved.
struct Queued {
    effect: HostEffect,
    /// The frame's size, or 0 for an effect that is not a frame.
    bytes: usize,
}

/// The intake budget the host's gate closes at, as TS's `outputFlow` does: a
/// quarter of the engine's queue limits closes it and a sixteenth reopens it
/// (`apps/daemon/src/engine/actor.ts:84`–`:103` with
/// `apps/daemon/src/engine/limits.ts:9`–`:17`: 256 frames and 4 MiB held, back
/// below 64 frames and 1 MiB). Past it, a stalled shell's backlog stops the
/// child's pumps instead of growing.
pub const INTAKE_FRAMES: usize = 256;
pub const INTAKE_FRAMES_RESUME: usize = 64;
pub const INTAKE_BYTES: usize = 4 * 1024 * 1024;
pub const INTAKE_BYTES_RESUME: usize = 1024 * 1024;

/// The error a call whose write the shell could not submit settles with.
const WRITE_LOST: &str = "JSON-RPC write failed";

/// What a shell does with the effects the host decides: it applies one effect
/// at a time, in the order `effect` is called, and it may run another input
/// from inside a call (acknowledging a write, reporting a failed stop), whose
/// effects follow.
pub trait HostSink: Send + Sync {
    fn effect(&self, host: &Host, effect: HostEffect);
}

impl Host {
    /// The shell takes its effects from now on. Everything the host decided
    /// before this is published first, in the order it decided it.
    pub fn set_sink(&self, sink: Arc<dyn HostSink>) {
        let publish = {
            let mut publication = self.publication();
            publication.sink = Some(sink);
            self.claim(&mut publication)
        };
        if publish {
            self.publish();
        }
    }

    pub(super) fn publication(&self) -> MutexGuard<'_, Publication> {
        self.publication
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// Runs one input under the host's lock, then publishes what it decided in
    /// the order the host decided it. Another input that decides meanwhile
    /// joins the same queue, so the two never swap their effects.
    pub(super) fn input<T>(&self, run: impl FnOnce(&mut Inner) -> T) -> T {
        let (result, publish) = {
            let mut inner = self.lock();
            let result = run(&mut inner);
            let mut publication = self.publication();
            // A frame decided while the queue is empty leaves at once, so only
            // a backlog pays for measuring it.
            let backlogged = publication.publishing || !publication.queue.is_empty();
            for effect in inner.out.drain(..) {
                let bytes = match &effect {
                    HostEffect::Frame { data, .. } if backlogged => data.to_json().len(),
                    _ => 0,
                };
                publication.hold(effect, bytes);
            }
            self.pace(&mut publication);
            (result, self.claim(&mut publication))
        };
        if publish {
            self.publish();
        }
        result
    }

    /// A write the sink never submitted: the peer releases its ticket, settles
    /// the call it carried and hands out the next line. Its effects wait for
    /// the next input, which claims the turn this unwinding drain gives back.
    fn write_lost(&self, ticket: u64) {
        self.input(|inner| {
            let peer = inner.peer.write_failed(ticket, WRITE_LOST);
            inner.apply(peer);
        });
    }

    /// Closes the gate while the backlog is at the intake budget, and reopens
    /// it once the sink has drained it.
    fn pace(&self, publication: &mut Publication) {
        let over = publication.frames >= INTAKE_FRAMES || publication.bytes >= INTAKE_BYTES;
        if over && !publication.paced {
            publication.paced = true;
            self.gate.set_backlog(true);
            return;
        }
        if publication.paced
            && publication.frames <= INTAKE_FRAMES_RESUME
            && publication.bytes <= INTAKE_BYTES_RESUME
        {
            publication.paced = false;
            self.gate.set_backlog(false);
        }
    }

    /// Takes the publication turn when nobody holds it and there is something
    /// to hand over, and a sink to hand it to.
    fn claim(&self, publication: &mut Publication) -> bool {
        if publication.publishing || publication.sink.is_none() || publication.queue.is_empty() {
            return false;
        }
        publication.publishing = true;
        true
    }

    /// Hands the queued effects to the sink, one at a time, in order, until
    /// the queue is empty. A decision made from inside an effect joins this
    /// same queue and follows the effects already decided. A sink that unwinds
    /// gives the turn back on its way out (`Claim`), so one panic never wedges
    /// publication; the effect it was given is the one that is lost, and a
    /// write it never submitted has its ticket failed in the peer (`Submitted`)
    /// so the shared stdin moves on.
    fn publish(&self) {
        let mut claim = Claim {
            host: self,
            held: true,
        };
        loop {
            let next = {
                let mut publication = self.publication();
                let Some(sink) = publication.sink.clone() else {
                    publication.publishing = false;
                    claim.held = false;
                    return;
                };
                match publication.queue.pop_front() {
                    Some(queued) => {
                        publication.release(&queued);
                        (sink, queued.effect)
                    }
                    None => {
                        publication.publishing = false;
                        claim.held = false;
                        return;
                    }
                }
            };
            {
                let mut publication = self.publication();
                self.pace(&mut publication);
            }
            let mut submitted = Submitted {
                host: self,
                done: false,
                ticket: match &next.1 {
                    HostEffect::Write { ticket, .. } => Some(*ticket),
                    _ => None,
                },
            };
            next.0.effect(self, next.1);
            submitted.done = true;
        }
    }
}

/// The write `publish` is handing to the sink. Dropping it with a ticket still
/// its own (a sink that unwound before submitting) fails that write in the
/// peer, so its slot is released and the next line goes out: TS's writer does
/// the same when `stream.write` throws (`rpc-writer.ts:107`–`:120`).
struct Submitted<'a> {
    host: &'a Host,
    ticket: Option<u64>,
    done: bool,
}

impl Drop for Submitted<'_> {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        let Some(ticket) = self.ticket else {
            return;
        };
        self.host.write_lost(ticket);
    }
}

/// The publication turn `publish` holds. Dropping it held (a sink that
/// unwound) gives the turn back, so the next input claims it and drains what
/// the panicking one left queued.
struct Claim<'a> {
    host: &'a Host,
    held: bool,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        if !self.held {
            return;
        }
        self.host.publication().publishing = false;
    }
}
