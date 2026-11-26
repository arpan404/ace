// SPDX-License-Identifier: Apache-2.0
//! The memoized close (`session.ts:182`-`:194`) and the stop it asks the caller for
//! (`host.ts:254`-`:267`). One close is in flight at a time; every later caller waits on it, and
//! a caller after it settled hears the same outcome, as `closing ??=` keeps the promise.

use ace_adapter_api::bridge::queue::{SessionErrorWire, SessionEvent};

use super::super::core::{CoreEffect, CursorSessionCore, PORT_STOP_CHILD};
use super::super::error::HostErrorWire;
use super::super::host::PEER_CLOSED;
use super::close_params;

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

/// `close` (`session.ts:182`-`:194`), memoized: a second caller waits on the first close, and a
/// caller after it settled hears the same outcome (`closing ??=` keeps the promise forever).
pub(crate) fn close(
    core: &mut CursorSessionCore,
    facade_id: u64,
    reason: ace_adapter_api::session::CloseReason,
) -> Vec<CoreEffect> {
    if let Some(outcome) = core.close_outcome.clone() {
        return settle_closed(core, CloseWaiter::Facade(facade_id), outcome);
    }
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

/// A close that already settled answers a later waiter with its own outcome, and does no work:
/// no second request, no second stop (`session.ts:183`'s `closing` is the settled promise).
fn settle_closed(
    core: &mut CursorSessionCore,
    waiter: CloseWaiter,
    outcome: Option<HostErrorWire>,
) -> Vec<CoreEffect> {
    match waiter {
        CloseWaiter::Facade(facade_id) => vec![settled(facade_id, outcome)],
        CloseWaiter::Interrupt {
            facade_id,
            cancel_error,
        } => {
            core.state.control = false;
            match outcome {
                Some(error) => vec![settled(facade_id, Some(error))],
                None => {
                    core.state.active = false;
                    vec![settled(facade_id, cancel_error)]
                }
            }
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

/// The child is stopped: the waiters hear what the close decided, and its outcome is kept for
/// every later close.
pub(crate) fn close_stopped(core: &mut CursorSessionCore) -> Vec<CoreEffect> {
    let Some(flight) = core.closing.take() else {
        return Vec::new();
    };
    core.close_outcome = Some(flight.request_error.clone());
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
    if let Some(outcome) = core.close_outcome.clone() {
        out.extend(settle_closed(core, waiter, outcome));
        return;
    }
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
