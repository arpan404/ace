// SPDX-License-Identifier: Apache-2.0
//! The command machines: `send` (a cancel first when the turn is active), `interrupt` and
//! `close` over the host's requests (`session.ts:182`-`:303`). Each input issues a request with
//! an internal id; its settle comes back through [`super::super::core`], and the machine moves on
//! under the same lock that admitted it.

use ace_adapter_api::session::Delivery;
use ace_json::Value;

use super::super::core::{CoreEffect, CursorSessionCore};
use super::super::error::HostErrorWire;
use super::close::interrupt_close;
use super::{CursorSend, cancel_body, input_rejected};
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

/// The interrupt in flight (`session.ts:285`-`:303`).
pub(crate) struct Interrupting {
    pub(crate) facade_id: u64,
    pub(crate) internal: u64,
}

/// `send` (`session.ts:230`-`:284`): the refusals here, the rest as the machine. The effects are
/// appended to `out` even when the send is refused after its frame went out: `session.ts` calls
/// `frame` before the request that can fail.
pub(crate) fn send(
    core: &mut CursorSessionCore,
    facade_id: u64,
    send: CursorSend<'_>,
    out: &mut Vec<CoreEffect>,
) -> Result<(), HostErrorWire> {
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
    // `session.ts:245`-`:283`: `control = true` then `try { ... } finally { control = false }`.
    // The finally runs on a synchronous failure only; an in-flight request clears it on settle.
    core.state.control = true;
    match start(core, facade_id, &send, replacing, out) {
        Ok(()) => Ok(()),
        Err(error) => {
            core.state.control = false;
            Err(error)
        }
    }
}

/// The first half of `session.ts:250`-`:272`: the steer's frame, the command's state and the
/// cancel that precedes the send, or the send itself when no turn runs.
fn start(
    core: &mut CursorSessionCore,
    facade_id: u64,
    send: &CursorSend<'_>,
    replacing: bool,
    out: &mut Vec<CoreEffect>,
) -> Result<(), HostErrorWire> {
    let command_id = send.command_id.map(str::to_owned);
    if replacing {
        let body = cancel_body(true, command_id.as_deref());
        core.frame(
            ace_adapter_api::frame::FrameDirection::Send,
            frames::KIND_CANCEL,
            &body,
            out,
        )?;
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
        // `session.ts:250` and `:255`: a cancel that cannot be written is a refusal of the
        // input, and the input never reaches Cursor (`refusedByHost`'s safe case).
        return match core.host.request("cancel", None, internal, None) {
            Ok(effects) => {
                out.extend(core.map_host(effects));
                Ok(())
            }
            Err(error) => {
                core.sending = None;
                Err(input_rejected(error.message()))
            }
        };
    }
    core.start_send(out)
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
    out: &mut Vec<CoreEffect>,
) -> Result<(), HostErrorWire> {
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
    let body = cancel_body(false, None);
    if let Err(error) = core.frame(
        ace_adapter_api::frame::FrameDirection::Send,
        frames::KIND_CANCEL,
        &body,
        out,
    ) {
        core.state.control = false;
        return Err(error);
    }
    let internal = core.alloc_internal();
    core.interrupting = Some(Interrupting {
        facade_id,
        internal,
    });
    match core.host.request("cancel", None, internal, None) {
        Ok(settled) => {
            out.extend(core.map_host(settled));
            Ok(())
        }
        Err(error) => {
            // `session.ts:293`-`:298`: the inner `finally` still closes the host when the cancel
            // could not be written. The close's settle carries the cancel's error, and `control`
            // is cleared when it stops, as the outer `finally` runs after `await close`.
            core.interrupting = None;
            let cancel_error = super::rpc_error(error.message());
            interrupt_close(core, facade_id, Some(cancel_error), out);
            Ok(())
        }
    }
}
