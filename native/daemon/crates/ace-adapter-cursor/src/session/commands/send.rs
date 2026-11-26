// SPDX-License-Identifier: Apache-2.0
//! The command machines: `send` (a cancel first when the turn is active), `interrupt` and
//! `close` over the host's requests (`session.ts:182`-`:303`). Each input issues a request with
//! an internal id; its settle comes back through [`super::super::core`], and the machine moves on
//! under the same lock that admitted it.

use ace_adapter_api::bridge::queue::{SessionErrorWire, SessionEvent};
use ace_adapter_api::session::Delivery;
use ace_json::Value;

use super::super::core::{CoreEffect, CursorSessionCore, PORT_STOP_CHILD};
use super::super::error::HostErrorWire;
use super::super::host::PEER_CLOSED;
use super::{CursorSend, cancel_body, close_params, input_rejected};
use crate::session::frames;

/// Where a send is in its machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SendStage {
    /// The host is cancelling the running turn; the send follows its reply.
    Cancel,
    Send,
}

/// One send in flight (`session.ts:245`-`:283`).
pub(crate) struct Sending {
    pub(crate) facade_id: u64,
    pub(crate) stage: SendStage,
    pub(crate) replacement: bool,
    pub(crate) command_id: Option<String>,
    pub(crate) operation_id: Option<String>,
    pub(crate) input: Value,
    /// The internal id of the cancel or send the machine awaits.
    pub(crate) internal: u64,
}

/// Who waits on the memoized close.
pub(crate) enum CloseWaiter {
    Facade(u64),
    /// The interrupt's own close (`session.ts:297`), settled with the cancel's error if it had one.
    Interrupt {
        facade_id: u64,
        cancel_error: Option<HostErrorWire>,
    },
}

/// The close in flight (`session.ts:182`-`:194`), memoized as `closing` is.
pub(crate) struct CloseFlight {
    pub(crate) waiters: Vec<CloseWaiter>,
    /// The `close` request's internal id, until it settles.
    pub(crate) internal: Option<u64>,
    pub(crate) request_error: Option<HostErrorWire>,
    /// The child's stop was asked for; its port's answer settles the waiters.
    pub(crate) stopping: bool,
}

/// The interrupt in flight (`session.ts:285`-`:303`).
pub(crate) struct Interrupting {
    pub(crate) facade_id: u64,
    pub(crate) internal: u64,
}

/// `send` (`session.ts:230`-`:284`): the refusals here, the rest as the machine.
pub(crate) fn send(
    core: &mut CursorSessionCore,
    facade_id: u64,
    send: CursorSend<'_>,
) -> Result<Vec<CoreEffect>, HostErrorWire> {
    if core.state.closed || core.closing.is_some() || core.state.exited {
        return Err(input_rejected("SDK host is closed"));
    }
    if core.state.uncertain {
        return Err(input_rejected(
            "SDK delivery or terminal state is uncertain; close and reconcile before sending",
        ));
    }
    if core.state.control {
        return Err(input_rejected("SDK control already in flight"));
    }
    if let Err(error) =
        crate::session::bounded::bounded_check(send.input, core.limits.max_input_bytes)
    {
        return Err(input_rejected(error.to_string()));
    }
    let replacing = send.delivery == Delivery::Steer && core.state.active;
    if replacing && send.steer_lost {
        // The fence failed in the caller's hands; it rethrows the error it kept (`session.ts:248`).
        return Err(super::steer_target_lost());
    }
    core.state.control = true;
    let mut effects = Vec::new();
    let command_id = send.command_id.map(str::to_owned);
    if replacing {
        let body = cancel_body(true, command_id.as_deref());
        core.frame(
            ace_adapter_api::frame::FrameDirection::Send,
            frames::KIND_CANCEL,
            &body,
            &mut effects,
        );
    }
    let needs_cancel = replacing || core.state.active;
    let stage = if needs_cancel {
        SendStage::Cancel
    } else {
        core.state.operation = operation_for(core, send.command_id, send.operation_id);
        core.state.segment = 0.0;
        SendStage::Send
    };
    let internal = core.alloc_internal();
    core.sending = Some(Sending {
        facade_id,
        stage,
        replacement: replacing,
        command_id,
        operation_id: send.operation_id.map(str::to_owned),
        input: send.input.clone(),
        internal,
    });
    if needs_cancel {
        let effects_cancel = core
            .host
            .request("cancel", None, internal, None)
            .map_err(|error| super::rpc_error(error.message()))?;
        effects.extend(core.map_host(effects_cancel));
        return Ok(effects);
    }
    core.start_send(&mut effects)?;
    Ok(effects)
}

/// The operation id (`session.ts:260`): `commandId ?? options.operationId?.()`, else
/// `<generation>:<seq>`, and the number it takes is the one a frame would have taken next.
fn operation_for(
    core: &mut CursorSessionCore,
    command_id: Option<&str>,
    operation_id: Option<&str>,
) -> String {
    match command_id.or(operation_id) {
        Some(operation) => operation.to_owned(),
        None => {
            let seq = core.queue.reserve_seq();
            format!("{}:{seq}", core.generation)
        }
    }
}

/// `interrupt` (`session.ts:285`-`:303`). Cursor advertises `interruptCascades: true`
/// (`policy.ts:22`), and its interrupt closes the one host every SDK task runs in
/// (`session.ts:294`-`:298`), so the close is the cascade: no request is made per child and
/// `cascade` takes the same path as its absence, exactly as `session.ts:285` does.
pub(crate) fn interrupt(
    core: &mut CursorSessionCore,
    facade_id: u64,
    agent: Option<&str>,
    cascade: bool,
) -> Result<Vec<CoreEffect>, HostErrorWire> {
    // A named child stays untargetable (`session.ts:288`). The close below stops every task in
    // the host for both values, so the cascade needs no branch: `session.ts:285` never reads
    // `target.cascade` either.
    let _ = cascade;
    if let Some(agent) = agent
        && agent != core.root_key
    {
        return Err(super::plain(
            "unsupported: Cursor SDK task children are read-only",
        ));
    }
    if core.state.control {
        return Err(super::plain("SDK control already in flight"));
    }
    core.state.control = true;
    let mut effects = Vec::new();
    let body = cancel_body(false, None);
    core.frame(
        ace_adapter_api::frame::FrameDirection::Send,
        frames::KIND_CANCEL,
        &body,
        &mut effects,
    );
    let internal = core.alloc_internal();
    core.interrupting = Some(Interrupting {
        facade_id,
        internal,
    });
    let settled = core
        .host
        .request("cancel", None, internal, None)
        .map_err(|error| super::rpc_error(error.message()))?;
    effects.extend(core.map_host(settled));
    Ok(effects)
}

/// `close` (`session.ts:182`-`:194`), memoized: a second caller waits on the first close.
pub(crate) fn close(
    core: &mut CursorSessionCore,
    facade_id: u64,
    reason: ace_adapter_api::session::CloseReason,
) -> Vec<CoreEffect> {
    if let Some(flight) = &mut core.closing {
        flight.waiters.push(CloseWaiter::Facade(facade_id));
        return Vec::new();
    }
    core.state.deliberate = true;
    core.state.closed = true;
    core.closing = Some(CloseFlight {
        waiters: vec![CloseWaiter::Facade(facade_id)],
        internal: None,
        request_error: None,
        stopping: false,
    });
    if core.state.exited {
        return request_stop(core);
    }
    let params = close_params(reason);
    let internal = core.alloc_internal();
    if let Some(flight) = &mut core.closing {
        flight.internal = Some(internal);
    }
    match core
        .host
        .request("close", Some(&params), internal, Some(core.limits.grace_ms))
    {
        Ok(effects) => core.map_host(effects),
        Err(error) => {
            if let Some(flight) = &mut core.closing {
                flight.request_error = Some(super::rpc_error(error.message()));
            }
            request_stop(core)
        }
    }
}

/// Ask the caller to stop the child, once (`host.ts:254`-`:267`): the host's RPC is disposed
/// first, as `host.stop()` does.
pub(crate) fn request_stop(core: &mut CursorSessionCore) -> Vec<CoreEffect> {
    if core.closing.as_ref().is_some_and(|flight| flight.stopping) {
        return Vec::new();
    }
    if let Some(flight) = &mut core.closing {
        flight.stopping = true;
    }
    let closed = core.host.close(PEER_CLOSED);
    let mut effects = core.map_host(closed);
    effects.push(CoreEffect::Event(SessionEvent::Port {
        name: PORT_STOP_CHILD,
        json: String::from("{}"),
    }));
    effects
}

/// The child is stopped: the waiters hear what the close decided.
pub(crate) fn close_stopped(core: &mut CursorSessionCore) -> Vec<CoreEffect> {
    let Some(flight) = core.closing.take() else {
        return Vec::new();
    };
    let mut effects = Vec::new();
    for waiter in flight.waiters {
        match waiter {
            CloseWaiter::Facade(facade_id) => {
                effects.push(settled(facade_id, flight.request_error.clone()));
            }
            CloseWaiter::Interrupt {
                facade_id,
                cancel_error,
            } => {
                core.state.control = false;
                match &flight.request_error {
                    Some(error) => effects.push(settled(facade_id, Some(error.clone()))),
                    None => {
                        core.state.active = false;
                        effects.push(settled(facade_id, cancel_error));
                    }
                }
            }
        }
    }
    effects
}

/// One caller promise settled with what its command decided.
pub(crate) fn settled(facade_id: u64, error: Option<HostErrorWire>) -> CoreEffect {
    CoreEffect::Event(SessionEvent::Settle {
        id: facade_id,
        result: match error {
            Some(error) => Err(SessionErrorWire {
                code: error.code,
                message: error.message,
            }),
            None => Ok(String::from("null")),
        },
    })
}

/// The interrupt's close (`session.ts:294`-`:298`): the memoized close, with the interrupt as its
/// waiter, so a close already in flight is joined rather than restarted.
pub(crate) fn interrupt_close(
    core: &mut CursorSessionCore,
    facade_id: u64,
    cancel_error: Option<HostErrorWire>,
    out: &mut Vec<CoreEffect>,
) {
    let waiter = CloseWaiter::Interrupt {
        facade_id,
        cancel_error,
    };
    if let Some(flight) = &mut core.closing {
        flight.waiters.push(waiter);
        return;
    }
    core.state.deliberate = true;
    core.state.closed = true;
    core.closing = Some(CloseFlight {
        waiters: vec![waiter],
        internal: None,
        request_error: None,
        stopping: false,
    });
    if core.state.exited {
        out.extend(request_stop(core));
        return;
    }
    let params = close_params(ace_adapter_api::session::CloseReason::User);
    let internal = core.alloc_internal();
    if let Some(flight) = &mut core.closing {
        flight.internal = Some(internal);
    }
    match core
        .host
        .request("close", Some(&params), internal, Some(core.limits.grace_ms))
    {
        Ok(effects) => out.extend(core.map_host(effects)),
        Err(error) => {
            if let Some(flight) = &mut core.closing {
                flight.request_error = Some(super::rpc_error(error.message()));
            }
            out.extend(request_stop(core));
        }
    }
}
