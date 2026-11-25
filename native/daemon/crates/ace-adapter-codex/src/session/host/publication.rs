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
    /// Effects waiting that carry something, and their bytes: what the gate
    /// watches.
    entries: usize,
    bytes: usize,
    /// The gate is closed because of this backlog.
    paced: bool,
}

impl Publication {
    /// Queues one effect, counting the payload it holds.
    fn hold(&mut self, effect: HostEffect, payload: Option<usize>) {
        if let Some(bytes) = payload {
            self.entries += 1;
            self.bytes += bytes;
        }
        self.queue.push_back(Queued { effect, payload });
    }

    /// The effect left the queue: its reservation goes with it.
    fn release(&mut self, queued: &Queued) {
        if let Some(bytes) = queued.payload {
            self.entries = self.entries.saturating_sub(1);
            self.bytes = self.bytes.saturating_sub(bytes);
        }
    }
}

/// One effect waiting for the shell, with what it reserved.
struct Queued {
    effect: HostEffect,
    /// The effect's payload size, or `None` when it carries nothing (it then
    /// takes no room in the intake budget).
    payload: Option<usize>,
}

impl HostEffect {
    /// What this effect carries for the shell, in bytes, or `None` when it
    /// carries nothing. Every payload-bearing effect counts against the intake
    /// budget, not just frames: a diagnostic or a malformed line piles up the
    /// same way when the shell has stopped taking effects.
    fn payload_bytes(&self) -> Option<usize> {
        Some(match self {
            HostEffect::Frame { data, .. } => payload_size(data),
            HostEffect::Notification { method, params, .. }
            | HostEffect::ServerRequest { method, params, .. } => {
                method.len_utf16() + 2 + params.as_ref().map_or(0, payload_size)
            }
            HostEffect::Dropped { line, .. } => line.bytes,
            HostEffect::Malformed { line, .. } | HostEffect::Stderr { line, .. } => line.len() + 2,
            HostEffect::Error { message, .. }
            | HostEffect::OpenFailed { message, .. }
            | HostEffect::DetachFailed { message, .. } => message.len() + 2,
            HostEffect::Write { wire, .. } => wire.len(),
            HostEffect::Settle { result, .. } => result.as_ref().map_or(0, payload_size),
            _ => return None,
        })
    }
}

/// A value's size as JSON text, counted without encoding it: keys, strings and
/// the punctuation between them. Iterative, so a deeply nested frame cannot
/// grow the stack (the parser has no depth limit).
fn payload_size(value: &Value) -> usize {
    let mut total = 0;
    let mut stack = vec![value];
    while let Some(value) = stack.pop() {
        match value {
            Value::Null => total += 4,
            Value::Bool(true) => total += 4,
            Value::Bool(false) => total += 5,
            Value::Number(_) => total += 8,
            Value::String(text) => total += text.len_utf16() + 2,
            Value::Array(items) => {
                total += 2 + items.len();
                stack.extend(items.iter());
            }
            Value::Object(map) => {
                total += 2 + map.len();
                for (key, value) in map.iter() {
                    total += key.len_utf16() + 3;
                    stack.push(value);
                }
            }
        }
    }
    total
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

/// What a shell does with the effects the host decides: it applies one effect
/// at a time, in the order `effect` is called, and it may run another input
/// from inside a call (acknowledging a write, reporting a failed stop), whose
/// effects follow.
pub trait HostSink: Send + Sync {
    fn effect(&self, host: &Host, effect: HostEffect);
    /// Stops the child now, outside the publication order. The host's own
    /// cleanup hands this over directly: a sink that unwound must never keep
    /// the process alive, and a queued `Retire` may be behind it.
    fn stop(&self, host: &Host, reason: Retirement, awaited: bool);
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
            // A poisoned host has no shell left to hand anything to.
            if inner.poisoned {
                inner.out.clear();
                (result, false)
            } else {
                let mut publication = self.publication();
                // Every effect is measured, not only one queued behind another:
                // a single input can release a hold above the byte budget with
                // far fewer entries than the entry bound allows, and that batch
                // is exactly what a blocked sink leaves waiting.
                for effect in inner.out.drain(..) {
                    let payload = effect.payload_bytes();
                    publication.hold(effect, payload);
                }
                self.pace(&mut publication);
                (result, self.claim(&mut publication))
            }
        };
        if publish {
            self.publish();
        }
        result
    }

    /// Closes the gate while the backlog is at the intake budget, and reopens
    /// it once the sink has drained it.
    fn pace(&self, publication: &mut Publication) {
        let over = publication.entries >= INTAKE_FRAMES || publication.bytes >= INTAKE_BYTES;
        if over && !publication.paced {
            publication.paced = true;
            self.gate.set_backlog(true);
            return;
        }
        if publication.paced
            && publication.entries <= INTAKE_FRAMES_RESUME
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
    /// same queue and follows the effects already decided. An unwind in the
    /// sink is a bug, not a protocol event: it poisons the host once, here, and
    /// the effects that poison decides are what the shell hears next.
    fn publish(&self) {
        let mut claim = Claim {
            host: self,
            held: true,
        };
        let mut skipped = 0;
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
                        if skipped > 0 {
                            eprintln!(
                                "native host: {skipped} effect(s) skipped after a sink unwind"
                            );
                        }
                        return;
                    }
                }
            };
            {
                let mut publication = self.publication();
                self.pace(&mut publication);
            }
            let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                next.0.effect(self, next.1);
            }));
            if unwound.is_err() {
                if self.poisoned() {
                    // After the poison each effect stands alone: this one is
                    // skipped and logged, and the rest keeps its order.
                    skipped += 1;
                } else {
                    self.poison();
                }
                continue;
            }
        }
    }
}

impl Host {
    /// A channel callback unwound. A panic in the shell is a bug, not a
    /// protocol event, so the host ends as a crash would, and nothing it does
    /// here depends on the sink that unwound:
    ///
    /// - the child is stopped directly, not through the queue, and that stop is
    ///   idempotent against one already decided (`Inner::retire`);
    /// - effects already decided keep their place: a settlement or exit another
    ///   input queued is still delivered in order. Only what is decided now is
    ///   appended: a failure for each call still pending (not one already
    ///   settled ahead of it) and an exit for each channel without one.
    ///
    /// TS has no equivalent: a throwing callback there is an uncaught error
    /// (`docs/engine/behaviour.md`).
    fn poison(&self) {
        let (publish, stop) = {
            let mut inner = self.lock();
            if inner.poisoned {
                return;
            }
            inner.poisoned = true;
            // Calls the peer still holds fail; a call already settled has its
            // settlement queued, and keeps it.
            let closed = inner.peer.close(HOST_FAILED);
            inner.apply(closed);
            // The child stops now, never through the queue: a sink that
            // unwound must not keep the process alive, and its stop may be
            // exactly what is queued behind the effect that unwound.
            inner.retire(Retirement::RpcFailed, true);
            let stop = inner.take_retire();
            let exit = HostExit {
                reason: ExitReason::Exit,
                code: None,
                signal: None,
                pid: inner.pid,
                output_drained: false,
            };
            // Channels without an exit get one; an exit already decided stays.
            inner.exited(exit);
            let mut publication = self.publication();
            for effect in inner.out.drain(..) {
                let payload = effect.payload_bytes();
                publication.hold(effect, payload);
            }
            self.pace(&mut publication);
            (self.claim(&mut publication), stop)
        };
        if let Some((reason, awaited)) = stop {
            let sink = self.publication().sink.clone();
            if let Some(sink) = sink
                && std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    sink.stop(self, reason, awaited);
                }))
                .is_err()
            {
                eprintln!("native host: the child's stop unwound in the sink");
            }
        }
        if publish {
            self.publish();
        }
    }

    /// A channel callback unwound and the host was retired: nothing else is
    /// decided, published or started on it.
    pub fn poisoned(&self) -> bool {
        self.lock().poisoned
    }

    /// Effects waiting for the shell. A poisoned host leaves none behind.
    #[cfg(test)]
    pub(super) fn queued(&self) -> usize {
        self.publication().queue.len()
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
