// SPDX-License-Identifier: Apache-2.0
//! The prompts a session queues and the one in flight (`session.ts:664`-`:797`).
//!
//! The queue holds only prompts: a steer goes straight out (`input.rs`), and lands here
//! when the turn could not take it. The reply frames drive it, one drain at a time.

use super::content::encode_content;
use super::core::{AcpCore, AcpEffect, AcpErrorWire};
use super::input::STEER_TARGET_LOST;
use super::protocol::agent_methods;
use ace_adapter_api::session::InputSource;
use ace_json::{Map, Value};

/// One prompt waiting for its turn, or the prompt in flight (`session.ts:677`).
#[derive(Debug, Clone)]
pub(crate) struct Job {
    pub input: Vec<Value>,
    pub command_id: Option<String>,
    pub origin: Option<InputSource>,
    /// The send's fence: asked again when the queue reaches this job (`session.ts:718`).
    pub fence: Option<super::input::Fence>,
    /// The turn's prompt this fenced steer was admitted for (`input.rs::aimed_at`). Set only
    /// for a fence that names a turn; see `drain` for why a set `aim` is stale there.
    pub aim: Option<ace_supervisor::jsonrpc::RpcId>,
    pub batch: u64,
    pub bytes: usize,
}

/// One send's promise: `Promise.all` over the prompts it became (`session.ts:671`).
#[derive(Debug)]
pub(crate) struct BatchState {
    pub operation: u64,
    /// Prompts of this send that have not settled yet.
    pub open: usize,
    /// A line of it went out (a prompt, or a steer's request): its failures are uncertain
    /// (`unread_or_uncertain`, behaviour.md section 20 "ACP steer fate").
    pub wrote_any: bool,
    /// A *prompt* of it went out (`session.ts:609`), which is what lets a later job of the
    /// batch skip the fence: a steer that wrote and then fell back did not. `drain` decides
    /// staleness on this one, never on `wrote_any`.
    pub wrote_prompt: bool,
    /// The send's promise is settled; a later prompt of it changes nothing.
    pub settled: bool,
}

/// A steering request awaiting the agent's answer (`session.ts:646`-`:662`).
#[derive(Debug)]
pub(crate) struct SteerFlight {
    /// The send's batch, whose promise the answer settles.
    pub batch: u64,
    /// What to queue as the next prompt when the turn could not take the steer
    /// (`session.ts:659`).
    pub fallback: Job,
    /// The write ticket the peer handed out for this request, once it did: the steer is
    /// `written` only when the shell confirms that ticket (`session.ts:630`).
    pub ticket: Option<u64>,
}

/// The prompt in flight (`session.ts:769`-`:785`).
#[derive(Debug)]
pub(crate) struct ActivePrompt {
    pub batch: u64,
    /// Whether this prompt carried ace's guidance, so it is never sent twice.
    pub guidance: bool,
}
impl AcpCore {
    /// `drain` (`session.ts:704`): the next prompt, only when the session is idle.
    pub(crate) fn drain(&mut self, effects: &mut Vec<AcpEffect>) {
        loop {
            if self.active
                || self.selecting
                || self.closed
                || self.routing.holds_input()
                || !self.pending.is_empty()
                || self.shells.blocked()
                || self.shells.busy()
            {
                return;
            }
            let Some(job) = self.queue.pop_front() else {
                return;
            };
            let wrote_any = self
                .batches
                .get(&job.batch)
                .is_some_and(|batch| batch.wrote_any);
            let wrote_prompt = self
                .batches
                .get(&job.batch)
                .is_some_and(|batch| batch.wrote_prompt);
            // `next.fence && !next.fence.current() && !next.batch.written`
            // (`session.ts:718`), plus one rule this port adds on purpose: an aimed job is
            // stale here even when the fence still reads current. `drain` runs only while
            // nothing is active, so the prompt an aimed steer named has already settled; the
            // engine may not have applied that turn's end frames yet, which is why its fence
            // can still answer "current". TS would send the steer as the next prompt; Rust
            // refuses it so a steer never joins another run, and the engine requeues it
            // (`intent-delivery.ts:147`). Recorded in `docs/engine/behaviour.md` section 20.
            let stale =
                job.fence.as_ref().is_some_and(|fence| !fence.current()) || job.aim.is_some();
            if stale && !wrote_prompt {
                // Its turn ended before ACP was idle to take it: refused unread, never
                // written into another (`session.ts:718`).
                self.queued_bytes = self.queued_bytes.saturating_sub(job.bytes);
                self.settle_job(
                    job.batch,
                    Err(AcpErrorWire::steer_target_lost(STEER_TARGET_LOST)),
                    effects,
                );
                self.drop_batch(job.batch, effects);
                self.queue_changed(effects);
                continue;
            }
            self.queued_bytes = self.queued_bytes.saturating_sub(job.bytes);
            self.active = true;
            if let Some(command_id) = job.command_id.as_deref() {
                // Identity before echo, before the prompt that carries it (behaviour.md 8).
                let mut callback = Map::with_capacity(2);
                callback.insert("commandId", Value::from(command_id));
                callback.insert("nativeId", Value::from(command_id));
                effects.push(AcpEffect::Callback {
                    name: "onInputMessage",
                    json: Value::Array(vec![Value::Object(callback)].into()).to_json(),
                });
                self.emit_note("recorder", input_sending(command_id, job.origin), effects);
            }
            // ace's guidance rides in the connection's first prompt, never every turn,
            // where each copy would stay in history and re-bill (`session.ts:743`).
            let guidance = if self.guided {
                None
            } else {
                self.mcp
                    .as_ref()
                    .and_then(|mcp| mcp.guidance())
                    .map(str::to_owned)
            };
            let mut prompt: Vec<Value> = Vec::with_capacity(job.input.len() + 1);
            if let Some(text) = &guidance {
                let mut part = Map::with_capacity(2);
                part.insert("type", Value::from("text"));
                part.insert(
                    "text",
                    Value::from(format!("<ace-tool-guidance>\n{text}\n</ace-tool-guidance>")),
                );
                prompt.push(Value::Object(part));
            }
            let mut encoded = Vec::with_capacity(job.input.len());
            let mut refusal = None;
            for part in &job.input {
                match encode_content(part) {
                    Ok(part) => encoded.push(part),
                    Err(message) => refusal = Some(message),
                }
            }
            if let Some(message) = refusal {
                self.active = false;
                // `next.input.map(encodeContent)` throwing: `send`'s catch rethrows the raw
                // error once a prompt of the batch went out, and drops the rest otherwise
                // (`session.ts:629`-`:636`).
                let error = self.unread_or_uncertain(job.batch, &message);
                self.settle_job(job.batch, Err(error), effects);
                if !wrote_any {
                    self.drop_batch(job.batch, effects);
                }
                self.queue_changed(effects);
                continue;
            }
            prompt.extend(encoded);
            let mut params = Map::with_capacity(2);
            params.insert("sessionId", Value::String(self.native_session_id.clone()));
            params.insert("prompt", Value::Array(prompt.into()));
            let params = Value::Object(params);
            let call = self.alloc_internal_id();
            let prompt_frames = self.prompt_frames;
            let peer_effects = match self.peer.request(
                agent_methods::SESSION_PROMPT,
                Some(&params),
                call,
                ace_supervisor::peer::Timeout::Disabled,
            ) {
                Ok(peer_effects) => peer_effects,
                Err(err) => {
                    self.active = false;
                    let error = self.unread_or_uncertain(job.batch, err.message());
                    self.settle_job(job.batch, Err(error), effects);
                    if !wrote_any {
                        self.drop_batch(job.batch, effects);
                    }
                    // The job left the queue; the recorder's count must say so (`send`'s
                    // `finally` reports in TS, `session.ts:671`-`:675`).
                    self.queue_changed(effects);
                    continue;
                }
            };
            self.active_prompt = Some(ActivePrompt {
                batch: job.batch,
                guidance: guidance.is_some(),
            });
            self.apply_peer_effects(peer_effects, effects);
            // The request frame went out synchronously, or it failed without writing
            // (`session.ts:766`).
            if self.prompt_frames != prompt_frames
                && let Some(batch) = self.batches.get_mut(&job.batch)
            {
                batch.wrote_any = true;
                batch.wrote_prompt = true;
            }
            self.queue_changed(effects);
            return;
        }
    }

    /// The prompt's reply frame settles its turn (`session.ts:770`-`:788`): the send
    /// resolves, ace's guidance is spent and the next prompt may go out.
    pub(crate) fn prompt_replied(&mut self, effects: &mut Vec<AcpEffect>) {
        let Some(active) = self.active_prompt.take() else {
            return;
        };
        if active.guidance {
            self.guided = true;
        }
        self.active = false;
        // This send resolves (`session.ts:788`), and then a shell the turn left running
        // without proof refuses the rest of the queue (`:786`-`:787`).
        self.settle_job(active.batch, Ok(Value::Null.to_json()), effects);
        if self.shells.blocked() {
            self.reject_queue("ACP shell execution completion is unconfirmed", effects);
        }
        self.drain(effects);
    }

    /// A prompt that failed after its turn ended (`session.ts:786`-`:787`): the send
    /// rejects with that failure so the engine counts the input uncertain, never unread.
    pub(crate) fn prompt_refused(&mut self, message: String, effects: &mut Vec<AcpEffect>) {
        let Some(active) = self.active_prompt.take() else {
            return;
        };
        self.active = false;
        // Its turn already ended through `prompt_ended("")`, which ends its tools too
        // (`session.ts:781`-`:784`).
        let message = self.redact_message(&message);
        self.settle_job(active.batch, Err(AcpErrorWire::rpc_error(message)), effects);
        self.drain(effects);
    }

    /// Every promise a closed or failed session owes (`rejectQueue`, `session.ts:935`).
    pub(crate) fn reject_queue(&mut self, message: &str, effects: &mut Vec<AcpEffect>) {
        if let Some(active) = self.active_prompt.take() {
            let error = self.unread_or_uncertain(active.batch, message);
            self.settle_job(active.batch, Err(error), effects);
        }
        self.active = false;
        for job in std::mem::take(&mut self.queue) {
            let error = self.unread_or_uncertain(job.batch, message);
            self.settle_job(job.batch, Err(error), effects);
        }
        for (_, flight) in std::mem::take(&mut self.steering) {
            let error = self.unread_or_uncertain(flight.batch, message);
            self.finish_steer_batch(flight.batch, Err(error), effects);
        }
        self.queued_bytes = 0;
        self.batches.clear();
        self.queue_changed(effects);
    }

    /// A refusal before the write proves the input unread; once a prompt of the batch went
    /// out it may have reached the agent, so the failure stays uncertain
    /// (`session.ts:630`, `intent-delivery.ts:140`-`:147`).
    pub(crate) fn unread_or_uncertain(&self, batch: u64, message: &str) -> AcpErrorWire {
        if self
            .batches
            .get(&batch)
            .is_some_and(|state| state.wrote_any)
        {
            AcpErrorWire::rpc_error(self.redact_message(message))
        } else {
            AcpErrorWire::input_rejected(message.to_owned())
        }
    }

    /// `dropBatch` (`session.ts:694`): no prompt of this send reached the agent, so the
    /// rest of it must never go out later.
    fn drop_batch(&mut self, batch: u64, effects: &mut Vec<AcpEffect>) {
        let mut index = 0;
        let mut dropped = false;
        while index < self.queue.len() {
            if self.queue[index].batch == batch {
                if let Some(job) = self.queue.remove(index) {
                    self.queued_bytes = self.queued_bytes.saturating_sub(job.bytes);
                }
                dropped = true;
            } else {
                index += 1;
            }
        }
        if dropped {
            self.batches.shift_remove(&batch);
            self.queue_changed(effects);
        }
    }

    pub(crate) fn queue_changed(&mut self, effects: &mut Vec<AcpEffect>) {
        let mut note = Map::with_capacity(2);
        note.insert("event", Value::from("queue-changed"));
        note.insert("count", Value::from(self.queue.len() as f64));
        self.emit_note("recorder", Value::Object(note), effects);
    }

    /// One prompt of a send settled: its promise settles on the first failure, or once
    /// every prompt of it has (`session.ts:671`, `:789`-`:790`).
    fn settle_job(
        &mut self,
        batch: u64,
        result: Result<String, AcpErrorWire>,
        effects: &mut Vec<AcpEffect>,
    ) {
        let Some(state) = self.batches.get_mut(&batch) else {
            return;
        };
        state.open = state.open.saturating_sub(1);
        let operation = state.operation;
        let done = state.open == 0;
        // `Promise.all`: the first failure rejects the send, otherwise it waits for every
        // prompt of it.
        let settle = if !state.settled && (result.is_err() || done) {
            state.settled = true;
            Some(result)
        } else {
            None
        };
        if done {
            self.batches.shift_remove(&batch);
        }
        if let Some(result) = settle {
            self.settle_operation(operation, result, effects);
        }
    }

    /// A steer's answer settles the send's promise and ends its batch.
    pub(crate) fn finish_steer_batch(
        &mut self,
        batch: u64,
        result: Result<String, AcpErrorWire>,
        effects: &mut Vec<AcpEffect>,
    ) {
        let operation = self.batch_operation(batch);
        self.batches.shift_remove(&batch);
        self.settle_operation(operation, result, effects);
    }

    fn settle_operation(
        &mut self,
        operation: u64,
        result: Result<String, AcpErrorWire>,
        effects: &mut Vec<AcpEffect>,
    ) {
        effects.push(AcpEffect::Settle {
            id: operation,
            result,
        });
    }

    fn batch_operation(&self, batch: u64) -> u64 {
        self.batches
            .get(&batch)
            .map(|state| state.operation)
            .unwrap_or_default()
    }

    pub fn queue_len(&self) -> usize {
        self.queue.len()
    }

    pub fn queued_bytes(&self) -> usize {
        self.queued_bytes
    }
}

fn input_sending(command_id: &str, origin: Option<InputSource>) -> Value {
    let mut note = Map::with_capacity(3);
    note.insert("event", Value::from("input-sending"));
    note.insert("nativeId", Value::from(command_id));
    if let Some(origin) = origin {
        note.insert(
            "origin",
            Value::from(match origin {
                InputSource::Ace => "ace",
                InputSource::Agent => "agent",
            }),
        );
    }
    Value::Object(note)
}
