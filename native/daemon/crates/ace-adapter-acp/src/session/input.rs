// SPDX-License-Identifier: Apache-2.0
//! The send and its steering (`packages/adapter-acp/src/session.ts:591`-`:700`).
//!
//! A send is a prompt for the agent, or a steer into the prompt already running. Both
//! happen in one synchronous step here: the fence is read, the turn is compared and the
//! request is pushed with no await between them (ADR 0223 section 7 rule 1). The queue
//! the prompts land in is `queue.rs`; what waits comes back as an effect.

use std::sync::Arc;

use ace_adapter_api::AdapterApiError;
use ace_adapter_api::session::{Delivery, InputSource, SteerFence, assert_steer_target};
use ace_json::{Map, Value};

use super::content::{encode_content, native_command_inputs};
use super::core::{AcpCore, AcpEffect, AcpErrorWire};
use super::protocol::agent_methods;
use super::queue::{BatchState, Job, SteerFlight};

/// Prompts a session queues at once (`session.ts:607`).
pub const MAX_QUEUE_LENGTH: usize = 64;
/// Bytes a session queues at once (`session.ts:607`).
pub const MAX_QUEUED_BYTES: usize = 4 * 1024 * 1024;
/// A fenced steer whose turn ended (`ace_adapter_api::session::assert_steer_target`).
pub const STEER_TARGET_LOST: &str = "The turn this message was meant to join has ended";

/// The engine's fence, owned so the queue can ask it again when it reaches a queued
/// steer (`session.ts:718`), which outlives the send.
#[derive(Clone)]
pub struct Fence(Arc<dyn SteerFence + Send + Sync>);

impl Fence {
    pub fn new(fence: Arc<dyn SteerFence + Send + Sync>) -> Self {
        Self(fence)
    }

    pub fn as_dyn(&self) -> &dyn SteerFence {
        &*self.0
    }

    /// Whether the turn this fence named is still the one running, read now.
    pub fn current(&self) -> bool {
        self.0.current()
    }
}

impl std::fmt::Debug for Fence {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Fence")
            .field("turn", &self.0.turn())
            .finish()
    }
}

/// One `send`, as the facade hands it over after its own awaits.
pub struct InputSend<'a> {
    /// The facade promise this send settles.
    pub operation: u64,
    pub input: &'a [Value],
    pub delivery: Delivery,
    pub command_id: Option<&'a str>,
    pub origin: Option<InputSource>,
    /// The engine's fence, owned so the queue can ask it again when it reaches a queued
    /// steer (`session.ts:718`), which outlives this call. `current()` is also read in
    /// this same synchronous step, before the write.
    pub fence: Option<Fence>,
}

/// The prompt a fence is aimed at, when that fence names a turn. A runless fence (the engine's
/// yield, `delivery.ts:216`) says nothing about which prompt it means, so it never turns a
/// queued job stale on the strength of the prompt that happened to be running
/// (`session.ts:717`-`:723`).
fn aimed_at(
    fence: Option<&Fence>,
    prompt: &Option<ace_supervisor::jsonrpc::RpcId>,
) -> Option<ace_supervisor::jsonrpc::RpcId> {
    fence
        .filter(|fence| fence.as_dyn().turn().is_some())
        .and(prompt.clone())
}

impl AcpCore {
    /// `send` (`session.ts:591`): refuse before queueing, so the agent provably took none
    /// of the input, then steer or queue, then drain.
    ///
    /// **The race, in order.** A steer is aimed at one turn, and the turn can end between
    /// the engine's check and the moment the agent reads the input. The orders that
    /// matter, and what each one does:
    ///
    /// 1. The engine's fence already says the turn is gone. The facade's
    ///    `assertSteerTarget` refuses before this call, and this call refuses too through
    ///    `assert_steer_target`: nothing is written, nothing is queued, and the send
    ///    settles `SteerTargetLost`. Nothing is ever retried into another turn.
    /// 2. The fence is current, but no prompt of this session is in flight (its reply
    ///    frame landed in between): no turn can take a steer, so the input is queued as
    ///    the next prompt and never steered (`session.ts:613`-`:621`).
    /// 3. The fence is current, a prompt is in flight and `steerViaCancel` is false: the
    ///    `_session/steering` request is pushed in the same synchronous step as the reads
    ///    above, and its reply settles this send.
    /// 4. The reply says `promptRequired`: the turn is running but took no steer, so the
    ///    input is unconsumed and is queued as the next prompt (`session.ts:659`). Whether
    ///    it goes out then is order 7's question.
    /// 5. The reply names any other outcome: the input was taken (`injected`,
    ///    `startedNewTurn`) and the send resolves, or the send is refused
    ///    (`session.ts:660`-`:662`) and never retried.
    /// 6. The steer's reply never comes (a transport failure, or the session closing): its
    ///    frame already went out, so the send settles with the error the peer reported,
    ///    redacted, as `uncertain` and never as a refusal, so the engine never sends it
    ///    twice; a steer that never wrote is refused instead (`input.rs::finish_steer`).
    /// 7. A queued steer's fence is asked again when the queue reaches it
    ///    (`session.ts:717`-`:723`): when it is no longer current the steer is refused
    ///    unread as `SteerTargetLost`, never written into a later turn, and the rest of a
    ///    batch that wrote nothing is dropped (`session.ts:629`-`:632`). A fence that is
    ///    still current sends it, and so does a job whose batch already wrote a prompt
    ///    (`session.ts:718`, `!next.batch.written`).
    /// 8. `steerViaCancel`: this agent has no steering extension, so a steer is queued as
    ///    the next prompt like any other input (`session.ts:617`). The engine hands it over
    ///    after yielding the run, with a fence that names no turn (`delivery.ts:216`), so it
    ///    is never stale on the strength of the prompt that was running: only a fence naming
    ///    a turn can go stale that way (`aimed_at`).
    ///
    /// Everything that can await happened before this call (the facade's preparation), or
    /// happens after it as its own effect (the steer's reply, the prompt's end).
    pub fn send(&mut self, send: InputSend<'_>, effects: &mut Vec<AcpEffect>) {
        let operation = send.operation;
        let refuse = |error: AcpErrorWire, effects: &mut Vec<AcpEffect>| {
            effects.push(AcpEffect::Settle {
                id: operation,
                result: Err(error),
            });
        };
        if self.closed {
            return refuse(AcpErrorWire::input_rejected("ACP session closed"), effects);
        }
        if self.shells.blocked() {
            return refuse(
                AcpErrorWire::input_rejected("ACP shell execution completion is unconfirmed"),
                effects,
            );
        }
        if let Err(error) =
            assert_steer_target(send.delivery, send.fence.as_ref().map(Fence::as_dyn))
        {
            return refuse(failure_of(error), effects);
        }
        let prompts = match native_command_inputs(send.input) {
            Ok(prompts) => prompts,
            Err(message) => return refuse(AcpErrorWire::input_rejected(message), effects),
        };
        let bytes: usize = prompts.iter().map(|prompt| prompt.to_json().len()).sum();
        let queued = self.queue.len().saturating_add(prompts.len());
        if queued > MAX_QUEUE_LENGTH || self.queued_bytes.saturating_add(bytes) > MAX_QUEUED_BYTES {
            return refuse(
                AcpErrorWire::input_rejected("ACP input queue capacity reached"),
                effects,
            );
        }
        let command_id = send
            .command_id
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        // A steer is one prompt, into a running turn, for an agent with the extension.
        if send.delivery == Delivery::Steer
            && prompts.len() == 1
            && !self.steer_via_cancel
            && self.prompt_id.is_some()
        {
            let batch = self.new_batch(operation, 0);
            let aim = aimed_at(send.fence.as_ref(), &self.prompt_id);
            let fallback = Job {
                input: prompts[0]
                    .as_array()
                    .map(|parts| parts.to_vec())
                    .unwrap_or_default(),
                command_id: command_id.clone(),
                origin: send.origin,
                fence: send.fence.clone(),
                aim,
                batch,
                bytes,
            };
            match self.steer_now(
                &prompts[0],
                batch,
                fallback,
                send.fence.as_ref().map(Fence::as_dyn),
            ) {
                Ok(steered) => {
                    effects.extend(steered);
                    return;
                }
                Err(error) => {
                    // The steer was refused before it wrote, so this send's batch is over.
                    self.batches.shift_remove(&batch);
                    return refuse(error, effects);
                }
            }
        }
        let batch = self.new_batch(operation, prompts.len());
        for prompt in prompts {
            let bytes = prompt.to_json().len();
            self.queued_bytes = self.queued_bytes.saturating_add(bytes);
            self.queue.push_back(Job {
                input: prompt
                    .as_array()
                    .map(|parts| parts.to_vec())
                    .unwrap_or_default(),
                command_id: command_id.clone(),
                origin: send.origin,
                // A queue-delivery send carries no fence (`session.ts:627`).
                fence: if send.delivery == Delivery::Steer {
                    send.fence.clone()
                } else {
                    None
                },
                aim: if send.delivery == Delivery::Steer {
                    aimed_at(send.fence.as_ref(), &self.prompt_id)
                } else {
                    None
                },
                batch,
                bytes,
            });
            // `enqueue`'s queueChanged runs once per prompt (`session.ts:687`-`:689`).
            self.queue_changed(effects);
        }
        self.drain(effects);
    }

    /// A send's promise state, with its prompts counted (`session.ts:671`).
    fn new_batch(&mut self, operation: u64, open: usize) -> u64 {
        let batch = self.next_batch;
        self.next_batch = self.next_batch.saturating_add(1);
        self.batches.insert(
            batch,
            BatchState {
                operation,
                open,
                wrote_any: false,
                wrote_prompt: false,
                settled: false,
            },
        );
        batch
    }

    /// `steerNow` (`session.ts:644`): the fence is read again in this step, then the
    /// `_session/steering` request is pushed. Its reply comes back through
    /// [`AcpCore::finish_steer`].
    fn steer_now(
        &mut self,
        parts: &Value,
        batch: u64,
        fallback: Job,
        fence: Option<&dyn SteerFence>,
    ) -> Result<Vec<AcpEffect>, AcpErrorWire> {
        if let Some(fence) = fence
            && !fence.current()
        {
            return Err(AcpErrorWire::steer_target_lost(STEER_TARGET_LOST));
        }
        let encoded = encoded_parts(parts).map_err(AcpErrorWire::input_rejected)?;
        let mut params = Map::with_capacity(3);
        params.insert("sessionId", Value::String(self.native_session_id.clone()));
        params.insert("prompt", Value::Array(encoded.into()));
        let mut steering = Map::with_capacity(1);
        steering.insert("idleBehavior", Value::from("promptRequired"));
        let mut meta = Map::with_capacity(1);
        meta.insert("steering", Value::Object(steering));
        params.insert("_meta", Value::Object(meta));
        let params = Value::Object(params);
        let call = self.alloc_internal_id();
        let flight = SteerFlight {
            batch,
            fallback,
            ticket: None,
        };
        self.steering.insert(call, flight);
        match self.peer.request(
            agent_methods::SESSION_STEERING,
            Some(&params),
            call,
            ace_supervisor::peer::Timeout::Disabled,
        ) {
            Ok(peer_effects) => {
                // `written` means the line left the writer, not that it was taken: the
                // ticket the peer gave this request is confirmed by the shell's
                // acknowledgement (`AcpCore::written`), and until then the steer is unread
                // (`session.ts:630`, `intent-delivery.ts:140`-`:147`). It is this call's
                // own ticket even when the line queued behind another: a line queued ahead
                // (a cancel, an answer) must never stand for the steer. A request the peer
                // settled instead of writing has no ticket, and its failure is a refusal.
                let ticket = self.peer.write_ticket(call);
                if let Some(flight) = self.steering.get_mut(&call) {
                    flight.ticket = ticket;
                }
                let mut effects = Vec::new();
                self.apply_peer_effects(peer_effects, &mut effects);
                Ok(effects)
            }
            Err(err) => {
                self.steering.shift_remove(&call);
                self.batches.shift_remove(&batch);
                Err(AcpErrorWire::input_rejected(err.message().to_owned()))
            }
        }
    }

    /// The steering request's reply (`session.ts:657`-`:662`): taken, queued as the next
    /// prompt, or refused.
    pub(crate) fn finish_steer(
        &mut self,
        id: u64,
        result: Result<Value, String>,
        effects: &mut Vec<AcpEffect>,
    ) -> bool {
        let Some(flight) = self.steering.shift_remove(&id) else {
            return false;
        };
        match result {
            // The reply's `outcome` is flat (`session.ts:657`, `acp-registry.md`'s
            // steering section, the fake server's `_session/steering` answer).
            Ok(reply) => match reply.get("outcome").and_then(Value::as_str).unwrap_or("") {
                "injected" | "startedNewTurn" => {
                    self.finish_steer_batch(flight.batch, Ok(Value::Null.to_json()), effects);
                }
                "promptRequired" => {
                    // The turn took no steer: the input is unconsumed and queued.
                    if let Some(state) = self.batches.get_mut(&flight.batch) {
                        state.open = 1;
                    }
                    self.queued_bytes = self.queued_bytes.saturating_add(flight.fallback.bytes);
                    self.queue.push_back(flight.fallback);
                    self.queue_changed(effects);
                    self.drain(effects);
                }
                other => {
                    let named = if other.is_empty() {
                        "no outcome"
                    } else {
                        other
                    };
                    self.finish_steer_batch(
                        flight.batch,
                        Err(AcpErrorWire::input_rejected(format!(
                            "The agent couldn't take the steer ({named})"
                        ))),
                        effects,
                    );
                }
            },
            Err(message) => {
                // It was written, so a failure here may have reached the agent.
                let error = self.unread_or_uncertain(flight.batch, &message);
                self.finish_steer_batch(flight.batch, Err(error), effects);
            }
        }
        true
    }
}

fn encoded_parts(parts: &Value) -> Result<Vec<Value>, String> {
    let mut encoded = Vec::new();
    for part in parts
        .as_array()
        .map(|parts| parts.to_vec())
        .unwrap_or_default()
    {
        encoded.push(encode_content(&part)?);
    }
    Ok(encoded)
}

/// The engine-api class a fence refusal keeps (ADR 0223 section 7 rule 2).
fn failure_of(error: AdapterApiError) -> AcpErrorWire {
    match error {
        AdapterApiError::SteerTargetLost(message) => AcpErrorWire::steer_target_lost(message),
        AdapterApiError::InputRejected(message) => AcpErrorWire::input_rejected(message),
        other => AcpErrorWire::rpc_error(other.to_string()),
    }
}
