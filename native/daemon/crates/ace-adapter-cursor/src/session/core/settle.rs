// SPDX-License-Identifier: Apache-2.0
//! The settlement half of the session core: one host settlement routes to the flight that awaits
//! it (the open, a send's cancel or send, the interrupt's cancel, the close) or to the caller's
//! own promise, and each flight advances the machine here (`session.ts:250`-`:280`).

use ace_adapter_api::bridge::queue::SessionEvent;
use ace_json::Value;

use ace_adapter_api::frame::FrameDirection;

use super::super::error::HostErrorWire;
use super::super::frames;
use super::{CoreEffect, CursorSessionCore, INTERNAL_CALL_BIT};

impl CursorSessionCore {
    /// One host settlement: the internal flights first, then the caller's own promises.
    pub(super) fn settle(
        &mut self,
        id: u64,
        result: Result<String, HostErrorWire>,
        out: &mut Vec<CoreEffect>,
    ) {
        if id & INTERNAL_CALL_BIT == 0 {
            out.push(CoreEffect::Event(SessionEvent::Settle {
                id,
                result: result.map_err(session_error),
            }));
            return;
        }
        if self
            .opening
            .as_ref()
            .is_some_and(|opening| opening.internal == id)
        {
            self.finish_open(result, out);
            return;
        }
        if self
            .sending
            .as_ref()
            .is_some_and(|sending| sending.internal == id)
        {
            self.finish_send(result, out);
            return;
        }
        if self
            .interrupting
            .as_ref()
            .is_some_and(|interrupt| interrupt.internal == id)
        {
            let Some(interrupt) = self.interrupting.take() else {
                return;
            };
            let cancel_error = result.err();
            crate::session::commands::interrupt_close(self, interrupt.facade_id, cancel_error, out);
            return;
        }
        if self
            .closing
            .as_ref()
            .is_some_and(|close| close.internal == Some(id))
        {
            if let Some(close) = &mut self.closing {
                close.request_error = result.err();
            }
            out.extend(crate::session::commands::request_stop(self));
        }
    }

    /// The open's reply (`session.ts:195`-`:217`): the snapshot note first, then its agent id.
    fn finish_open(&mut self, result: Result<String, HostErrorWire>, out: &mut Vec<CoreEffect>) {
        let Some(opening) = self.opening.take() else {
            return;
        };
        let agent_id = match result {
            Ok(json) => match ace_json::parse(&json)
                .map_err(|_| String::from("Invalid open reply"))
                .and_then(|value| frames::open_agent_id(&value).map_err(|error| error.message()))
            {
                Ok(agent_id) => agent_id,
                Err(message) => {
                    out.push(settle_error(
                        opening.facade_id,
                        crate::session::commands::rpc_error(message),
                    ));
                    return;
                }
            },
            Err(error) => {
                out.push(settle_error(opening.facade_id, error));
                return;
            }
        };
        if let Some(snapshot) = opening.snapshot {
            // `session.ts:217`: the snapshot note is part of opening, so a body it cannot carry
            // fails the open instead of leaving the evidence out silently.
            if let Err(error) =
                self.frame(FrameDirection::Note, frames::KIND_SNAPSHOT, &snapshot, out)
            {
                out.push(settle_error(opening.facade_id, error));
                return;
            }
        }
        let mut reply = ace_json::Map::with_capacity(1);
        reply.insert("nativeSessionId", Value::String(agent_id));
        out.push(CoreEffect::Event(SessionEvent::Settle {
            id: opening.facade_id,
            result: Ok(Value::Object(reply).to_json()),
        }));
    }

    /// A cancel or send settled: the machine advances (`session.ts:250`-`:280`).
    fn finish_send(&mut self, result: Result<String, HostErrorWire>, out: &mut Vec<CoreEffect>) {
        let Some(sending) = self.sending.take() else {
            return;
        };
        let facade_id = sending.facade_id;
        match sending.stage {
            crate::session::commands::SendStage::Cancel => match result {
                Ok(_) => {
                    if sending.replacement {
                        self.state.segment += 1.0;
                    } else {
                        // The new turn's operation is the command's, else the caller's, else the
                        // sequence (`session.ts:260`).
                        self.state.operation = match sending
                            .command_id
                            .as_deref()
                            .or(sending.operation_id.as_deref())
                        {
                            Some(operation) => operation.to_owned(),
                            None => format!("{}:{}", self.generation, self.queue.reserve_seq()),
                        };
                        self.state.segment = 0.0;
                    }
                    self.sending = Some(sending);
                    if let Err(error) = self.start_send(out) {
                        self.state.control = false;
                        out.push(settle_error(facade_id, error));
                    }
                }
                Err(error) => {
                    self.state.control = false;
                    out.push(settle_error(
                        facade_id,
                        crate::session::commands::input_rejected(error.message),
                    ));
                }
            },
            crate::session::commands::SendStage::Send => match result {
                Ok(value) => {
                    self.state.control = false;
                    out.push(CoreEffect::Event(SessionEvent::Settle {
                        id: facade_id,
                        result: Ok(value),
                    }));
                }
                Err(error) => {
                    self.state.active = false;
                    self.state.uncertain = !self.state.terminal;
                    self.state.control = false;
                    let error = if crate::session::commands::refused_by_host(&error.message) {
                        crate::session::commands::input_rejected(error.message)
                    } else {
                        error
                    };
                    out.push(settle_error(facade_id, error));
                }
            },
        }
    }

    /// `host.request("send", ...)` (`session.ts:263`-`:272`), after the cancel when there was one.
    /// A synchronous failure is the catch at `session.ts:273`-`:280`: the turn is no longer active,
    /// its state is uncertain, and the input's promise rejects with the mapped error.
    pub(crate) fn start_send(&mut self, out: &mut Vec<CoreEffect>) -> Result<(), HostErrorWire> {
        self.state.active = true;
        self.state.terminal = false;
        let Some(mut sending) = self.sending.take() else {
            return Ok(());
        };
        sending.stage = crate::session::commands::SendStage::Send;
        if let Some(command_id) = &sending.command_id {
            out.push(CoreEffect::Event(SessionEvent::Callback {
                name: "onInputMessage",
                json: frames::input_message_args(command_id),
            }));
        }
        let params = crate::session::commands::send_params(
            &self.state.operation,
            sending.command_id.as_deref(),
            self.state.segment,
            &sending.input,
        );
        sending.internal = self.alloc_internal();
        match self
            .host
            .request("send", Some(&params), sending.internal, None)
        {
            Ok(effects) => {
                self.sending = Some(sending);
                out.extend(self.map_host(effects));
                Ok(())
            }
            Err(error) => {
                self.state.active = false;
                self.state.uncertain = !self.state.terminal;
                let error = if crate::session::commands::refused_by_host(&error.message()) {
                    crate::session::commands::input_rejected(error.message())
                } else {
                    crate::session::commands::rpc_error(error.message())
                };
                Err(error)
            }
        }
    }
}

/// A promise settled with a refusal or a failure.
fn settle_error(facade_id: u64, error: HostErrorWire) -> CoreEffect {
    CoreEffect::Event(SessionEvent::Settle {
        id: facade_id,
        result: Err(ace_adapter_api::bridge::queue::SessionErrorWire {
            code: error.code,
            message: error.message,
        }),
    })
}

/// A host failure as the queue carries it.
fn session_error(error: HostErrorWire) -> ace_adapter_api::bridge::queue::SessionErrorWire {
    ace_adapter_api::bridge::queue::SessionErrorWire {
        code: error.code,
        message: error.message,
    }
}
