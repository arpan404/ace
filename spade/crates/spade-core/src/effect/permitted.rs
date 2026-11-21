//! What a bot's Permissions decide at the gate (ADR 0171, amendment 7), in every mode, after
//! the package's ceiling and the organization's policy and before anything else:
//!
//! - a driving step runs under its family's switch (Computer use, Browser, Simulators and
//!   devices): on, it runs with no reviewer and no request, held to the page or app it was
//!   routed to; off, it is refused. Under Computer use an app on the person's never-use list is
//!   refused, and a step that must be held to a place Spade can't find or ace can't hold it to
//!   is refused, so the bot looks again;
//! - a connected app's tool, a send in the person's name and a payment are refused while their
//!   switch is off, and otherwise go the gate's usual way (a send and a payment still ask).
//!
//! Pure.

use super::{Call, Effect, Route};
use crate::permission::Switch;

/// Why the bot's Permissions refuse `call` before any other route, if they do.
pub(super) fn refusal(call: &Call<'_>) -> Option<String> {
    let switch = match call.effect {
        Some(Effect::Drive) => Switch::driving(call.tool),
        Some(Effect::SendAsPerson) => Some(Switch::Send),
        Some(Effect::Pay) => Some(Switch::Pay),
        _ => None,
    };
    let switch = switch.or(call.connected.then_some(Switch::Apps))?;
    (!call.permits.on(switch)).then(|| switch.off())
}

/// Where a driving step goes once its switch is on: it runs, unless it would act in an app on the
/// never-use list, or must be held to a place Spade can't find or ace can't hold it to.
pub(super) fn drive(call: Call<'_>) -> Route {
    // A driving tool outside the three families has no switch: nothing turns it on.
    let Some(switch) = Switch::driving(call.tool) else {
        return Route::Refuse(super::drive::UNPLACED_REFUSED.to_owned());
    };
    if !call.permits.on(switch) {
        return Route::Refuse(switch.off());
    }
    if let Some(entry) = call.drive.never {
        return Route::Refuse(crate::permission::never::refusal(entry));
    }
    match call.drive.target {
        Ok(_) if call.drive.bound => Route::Run,
        Ok(_) => Route::Refuse(super::drive::UNHELD.to_owned()),
        Err(_) if call.drive.placeless => Route::Run,
        Err(why) => Route::Refuse(super::drive::unplaced(why)),
    }
}

#[cfg(test)]
mod tests;
