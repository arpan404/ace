//! The organization ceiling in the gate (ADR 0206 §3): one more pure check in
//! [`crate::effect::route`], after the credential refusal and before the package ceiling, so a
//! shared bot's call must pass org ∩ package ∩ grants. It only narrows: it refuses what the
//! policy turns off, and sends to the bot's approvers an outward step nobody allowed, since an
//! effect with no human allower can't happen on a shared bot (§4.1).

use super::Policy;
use super::policy::gerund;
use crate::effect::{Effect, Place, Route};

/// What the gate knows of a shared bot's organization for one call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gate<'a> {
    /// The organization's name, for the refusal ("Acme doesn't allow paying.").
    pub org: &'a str,
    /// Its policy at the version this host verified and applied.
    pub policy: &'a Policy,
}

/// Whether `effect` acts outside the bot: what a shared bot does only with a member's say.
pub fn outward(effect: Option<Effect>) -> bool {
    matches!(
        effect,
        Some(
            Effect::Network
                | Effect::Publish
                | Effect::SendAsPerson
                | Effect::Pay
                | Effect::Drive
                | Effect::ChangeAccess
        )
    )
}

/// Why the organization refuses a call, if it does. `effect` is the gate's reading of it (a
/// command outside the sandbox raised to what it runs); `confined`: it runs in the bot's
/// sandbox, which holds its network to the hosts it was given.
pub fn refusal(
    gate: Gate<'_>,
    effect: Option<Effect>,
    place: Place,
    confined: bool,
) -> Option<String> {
    let outside = matches!(place, Place::AsksOutside | Place::Unsandboxed(_));
    if outside && !gate.policy.commands_outside_allowed() {
        return Some(format!(
            "{} doesn't allow commands outside the sandbox.",
            gate.org
        ));
    }
    let effect = effect?;
    if confined {
        return None;
    }
    gate.policy
        .forbids(effect)
        .then(|| format!("{} doesn't allow {}.", gate.org, gerund(effect)))
}

/// Where a shared bot's call goes once the rest of the gate decided `route`: an outward step
/// that would run with no member's say (the reviewer's verdict, a classifier, Full access) goes
/// to its approvers instead. `human`: an approver's Always allow or a member's grant covers it.
pub fn approvers(route: Route, effect: Option<Effect>, confined: bool, human: bool) -> Route {
    if confined || !outward(effect) {
        return route;
    }
    match route {
        Route::Run if human => Route::Run,
        Route::Run | Route::Review(_) => Route::Ask {
            line: APPROVERS.to_owned(),
            ask: None,
        },
        route => route,
    }
}

/// The line a shared bot's approvers see on such a request.
pub const APPROVERS: &str =
    "A shared bot acts outside only with an approver's answer, so one of its approvers decides.";
