// SPDX-License-Identifier: Apache-2.0
//! Codex's commands (`session-commands.ts:53`-`:356`) and the admission every
//! send passes through. The commands are sans-IO machines: each step is an
//! effect, and its reply comes back as an input, in the order the session
//! decided them.

use ace_adapter_api::session::{Delivery, InputSource, SteerFence, assert_steer_target};
use ace_json::{Map, Value};
use indexmap::IndexMap;

use super::frames::{Effect, Failure};
use super::input::native_input;
use super::state::Session;

mod approval;
mod interrupt;
mod request;
mod resolve;
mod steer;

#[cfg(test)]
mod tests;

use request::{on_input_message, start_params, steer_request};
use steer::SteerSettled;

pub use resolve::Answer;

/// The turn this message was meant to join has ended.
pub const STEER_TARGET_LOST: &str = "The turn this message was meant to join has ended";
/// Codex's own way of saying no turn is running (`/^no active turn to steer$/i`).
const NO_ACTIVE_TURN: &str = "no active turn to steer";
/// The prefix of Codex's other refusal (`/^expected active turn id .+ but found .+$/i`).
const EXPECTED_ACTIVE: &str = "expected active turn id ";

/// One `send`, as the facade hands it over after its own awaits.
pub struct Send<'a> {
    /// The facade promise this send settles.
    pub operation: u64,
    pub parts: &'a [Value],
    pub delivery: Delivery,
    pub command_id: Option<&'a str>,
    pub origin: Option<InputSource>,
    /// The engine's fence. `current()` was checked in this same synchronous
    /// step; `turn()` is compared against the turn the session last saw.
    pub fence: Option<&'a dyn SteerFence>,
    /// `io.userMessageId`: read under the lock, never awaited.
    pub user_message_id: &'a dyn Fn() -> String,
    /// The interaction this send answers (`sendAnswer`): its notes follow the
    /// reply, and its own promise settles after them.
    pub answering: Option<&'a str>,
}

/// The launch options an awaited port resolved (`getLaunchOptions`).
#[derive(Debug, Clone, PartialEq)]
pub struct Launch {
    /// `getPermissionMode()`'s answer, when the session reports one.
    pub mode: Option<String>,
    /// The policy and the selected effort and service tier.
    pub options: Map,
}

/// A start waiting for its launch options, by the facade's operation.
struct PendingStart {
    thread: String,
    /// Everything but the launch options and `threadId`.
    params: Map,
    answering: Option<String>,
}

/// One command waiting for a reply, by the call that will answer it.
enum Flight {
    Queue {
        thread: String,
        operation: u64,
    },
    Steer {
        thread: String,
        operation: u64,
        turn: String,
        input: Value,
        client_user_message_id: Option<String>,
        fenced: bool,
        answering: Option<String>,
    },
    /// A `turn/start`: its reply settles the operation.
    Turn {
        thread: String,
        operation: u64,
        answering: Option<String>,
    },
    /// An interrupt in flight (`interruptTree`).
    Interrupt {
        operation: u64,
        tree: interrupt::Tree,
    },
    /// A background terminal stop in flight (`stopShells`).
    StopShells {
        operation: u64,
        shells: interrupt::Shells,
    },
}

impl Flight {
    fn operation(&self) -> u64 {
        match self {
            Flight::Queue { operation, .. }
            | Flight::Steer { operation, .. }
            | Flight::Turn { operation, .. }
            | Flight::Interrupt { operation, .. }
            | Flight::StopShells { operation, .. } => *operation,
        }
    }
}

/// Every command a session has in flight.
#[derive(Default)]
pub(crate) struct Commands {
    flights: IndexMap<u64, Flight>,
    starts: IndexMap<u64, PendingStart>,
}

impl Commands {
    pub(crate) fn new() -> Commands {
        Commands::default()
    }

    fn insert(&mut self, call: u64, flight: Flight) {
        self.flights.insert(call, flight);
    }

    /// `cleanup()`: nothing more will be sent, so nothing still waits.
    pub(crate) fn clear(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        for (_, flight) in std::mem::take(&mut self.flights) {
            let operation = flight.operation();
            effects.extend(settle(
                operation,
                Err(Failure::failed("Codex session ended")),
            ));
        }
        for (operation, _) in std::mem::take(&mut self.starts) {
            effects.extend(settle(
                operation,
                Err(Failure::failed("Codex session ended")),
            ));
        }
        effects
    }
}

impl Session {
    /// `send`, from the facade: the root thread's commands.
    pub fn send(&mut self, send: Send<'_>) -> Vec<Effect> {
        let root = self.root.clone();
        self.send_to(&root, send)
    }

    /// `sendTo`, and the admission rule 1 asks for in E3.
    ///
    /// **The race, in order.** A steer is aimed at one turn, and the turn can
    /// end between the engine's check and the moment Codex reads the write. The
    /// orders that matter, and what each one does:
    ///
    /// 1. The engine's fence already says the turn is gone. The facade's
    ///    `assertSteerTarget` refuses before this call, and this call refuses
    ///    too: no effect, no write, `SteerTargetLost`. Nothing is ever retried
    ///    into another turn.
    /// 2. The fence says the turn is current, but the session's `active` names
    ///    no turn for the thread, or a different one: a `turn/completed` frame
    ///    landed in between. The compare below refuses unread, in the same lock
    ///    scope as the read, with `ACE_STEER_TARGET_LOST`; the steer is never
    ///    sent and never retried.
    /// 3. The fence says current, and `active` names that same turn: the steer
    ///    is pushed with `expectedTurnId` set to the turn just read, so Codex
    ///    checks the same fact again at its own boundary. The read and the push
    ///    are one step here; nothing awaits between them.
    /// 4. The turn ends after the push. Codex answers the steer with its own
    ///    refusal ("expected active turn id ... but found ...", or "no active
    ///    turn to steer"): a fenced steer becomes `SteerTargetLost` and is done.
    ///    An unfenced steer follows `session-commands.ts:117`-`:135`: into the
    ///    turn that replaced it, once, or, when no turn did, into a new turn that
    ///    carries the same input (it was refused unread), or, when Codex names
    ///    the very turn the session still has, `InputRejected`.
    /// 5. A turn is running and the fence names no turn: the steer joins the
    ///    running turn, exactly as an unfenced one does.
    ///
    /// Everything that can await (`getLaunchOptions`, `refreshQueue`, a
    /// request's reply) happens before this call or after it, as its own
    /// effect. What is left here is one synchronous step: assert, read, compare,
    /// queue the identity callback, push.
    pub(crate) fn send_to(&mut self, thread: &str, send: Send<'_>) -> Vec<Effect> {
        if let Err(message) = self.assert_open() {
            return settle(send.operation, Err(Failure::failed(message)));
        }
        if let Err(error) = assert_steer_target(send.delivery, send.fence) {
            return settle(send.operation, Err(failure_of(error)));
        }
        let turn = self.active.get(thread).cloned();
        if let Some(fence) = send.fence
            && send.delivery == Delivery::Steer
            && let Some(expected) = fence.turn()
            && Some(expected) != turn.as_deref()
        {
            return settle(
                send.operation,
                Err(Failure::steer_target_lost(STEER_TARGET_LOST)),
            );
        }
        // Identity before echo: the callback is queued before the write it
        // belongs to, so the engine knows the native id first (behaviour.md 8).
        let client_user_message_id = match send.origin != Some(InputSource::Ace) || turn.is_some() {
            true => Some((send.user_message_id)()),
            false => None,
        };
        let mut effects = Vec::new();
        if let (Some(command_id), Some(native_id)) = (
            send.command_id.filter(|command| !command.is_empty()),
            client_user_message_id.as_deref(),
        ) {
            effects.push(on_input_message(command_id, native_id));
        }
        let answering = send.answering.map(|key| key.to_owned());
        match (turn, send.delivery) {
            (Some(_turn), Delivery::Queue) => {
                let input = match native_input(send.parts) {
                    Ok(input) => input,
                    Err(message) => return settle(send.operation, Err(Failure::failed(message))),
                };
                let client_user_message_id =
                    client_user_message_id.unwrap_or_else(|| (send.user_message_id)());
                let call = self.calls.take();
                self.commands.insert(
                    call,
                    Flight::Queue {
                        thread: thread.to_owned(),
                        operation: send.operation,
                    },
                );
                let mut params = Map::new();
                params.insert("threadId", Value::from(thread.to_owned()));
                params.insert("input", input);
                params.insert("clientUserMessageId", Value::from(client_user_message_id));
                effects.push(Effect::Request {
                    call,
                    method: "thread/queue/add".to_owned(),
                    params: Value::Object(params),
                    timeout_ms: None,
                });
            }
            (Some(turn), Delivery::Steer) => {
                let input = match native_input(send.parts) {
                    Ok(input) => input,
                    Err(message) => return settle(send.operation, Err(Failure::failed(message))),
                };
                let call = self.calls.take();
                self.commands.insert(
                    call,
                    Flight::Steer {
                        thread: thread.to_owned(),
                        operation: send.operation,
                        turn: turn.clone(),
                        input: input.clone(),
                        client_user_message_id: client_user_message_id.clone(),
                        fenced: send.fence.is_some(),
                        answering,
                    },
                );
                effects.push(steer_request(
                    call,
                    thread,
                    &turn,
                    &input,
                    client_user_message_id.as_deref(),
                ));
            }
            (None, _) => {
                let params = match start_params(send.parts, send.origin, client_user_message_id) {
                    Ok(params) => params,
                    Err(message) => return settle(send.operation, Err(Failure::failed(message))),
                };
                effects.extend(self.begin_start(send.operation, thread, params, answering));
            }
        }
        effects
    }

    /// `startTurn`: its await is the launch-options port, so the facade resolves
    /// it and calls back here, which pushes the turn in one step.
    pub(crate) fn begin_start(
        &mut self,
        operation: u64,
        thread: &str,
        params: Map,
        answering: Option<String>,
    ) -> Vec<Effect> {
        self.commands.starts.insert(
            operation,
            PendingStart {
                thread: thread.to_owned(),
                params,
                answering,
            },
        );
        vec![Effect::LaunchOptions {
            id: operation,
            thread: thread.to_owned(),
        }]
    }

    /// `getLaunchOptions(threadId)` returned, or its failure: the note, then the
    /// push of the turn it was asked for.
    pub fn launch_ready(&mut self, operation: u64, launch: Result<Launch, String>) -> Vec<Effect> {
        let Some(start) = self.commands.starts.shift_remove(&operation) else {
            return Vec::new();
        };
        let launch = match launch {
            Ok(launch) => launch,
            Err(message) => return settle(operation, Err(Failure::failed(message))),
        };
        let mut note = Map::new();
        note.insert("event", Value::from("permission-turn-submitting"));
        note.insert("threadId", Value::from(start.thread.clone()));
        note.insert(
            "mode",
            match launch.mode {
                Some(mode) => Value::from(mode),
                None => Value::Null,
            },
        );
        let mut effects = self.emit_note(&Value::Object(note));
        let mut params = start.params;
        for (key, value) in launch.options {
            params.insert(key, value);
        }
        params.insert("threadId", Value::from(start.thread.clone()));
        let call = self.calls.take();
        self.commands.insert(
            call,
            Flight::Turn {
                thread: start.thread,
                operation,
                answering: start.answering,
            },
        );
        effects.push(Effect::Request {
            call,
            method: "turn/start".to_owned(),
            params: Value::Object(params),
            timeout_ms: None,
        });
        effects
    }

    /// One command's reply, when this call is a command's.
    pub(crate) fn command_settled(
        &mut self,
        call: u64,
        reply: Result<&Value, &str>,
    ) -> Option<Vec<Effect>> {
        let flight = self.commands.flights.shift_remove(&call)?;
        Some(match flight {
            Flight::Queue { thread, operation } => match reply {
                Ok(_) => self.refresh_queue_for(&thread, Some(operation)),
                Err(message) => settle(operation, Err(Failure::failed(message))),
            },
            Flight::Steer {
                thread,
                operation,
                turn,
                input,
                client_user_message_id,
                fenced,
                answering,
            } => self.steer_settled(
                SteerSettled {
                    thread,
                    operation,
                    turn,
                    input,
                    client_user_message_id,
                    fenced,
                    answering,
                },
                reply,
            ),
            Flight::Turn {
                thread,
                operation,
                answering,
            } => self.turn_settled(thread, operation, answering, reply),
            Flight::Interrupt { operation, tree } => self.interrupt_step(operation, tree, reply),
            Flight::StopShells { operation, shells } => {
                self.stop_shells_step(operation, shells, reply)
            }
        })
    }
}

/// The call one step waits on, when it asked for something.
pub(crate) fn call_of(effect: &Effect) -> Option<u64> {
    match effect {
        Effect::Request { call, .. } => Some(*call),
        _ => None,
    }
}

pub(crate) fn settle(operation: u64, result: Result<Value, Failure>) -> Vec<Effect> {
    vec![Effect::Settle {
        id: operation,
        result,
    }]
}

/// The engine-api class a fence refusal keeps (ADR 0223 section 7 rule 2).
fn failure_of(error: ace_adapter_api::AdapterApiError) -> Failure {
    match error {
        ace_adapter_api::AdapterApiError::SteerTargetLost(message) => {
            Failure::steer_target_lost(message)
        }
        other => Failure::failed(other.to_string()),
    }
}

/// `assertOpen`: commands refuse once the session is closed.
pub(crate) fn closed(operation: u64) -> Vec<Effect> {
    settle(operation, Err(Failure::failed("Codex session is closed")))
}
