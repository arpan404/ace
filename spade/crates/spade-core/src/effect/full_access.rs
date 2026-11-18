//! Where a call goes for a bot in Full access (ADR 0163, amendment 2), once [`super::route`] has
//! applied the hard stops every mode keeps: a secret refused; a payment, a send in the person's
//! name, an access change and an effect Spade doesn't know asking the person. Ordinary work runs
//! with no reviewer, and untrusted content in view adds no ask, except for an app's tool. What
//! still asks:
//!
//! - a driving step in a place where a step could send, pay or change access (mail and chat, money,
//!   passwords, sign-in and account pages, settings, social sites, a browser driven through the
//!   screen), on a simulator or device or an app that shows one, or where Spade can't tell where
//!   it acts or ace can't hold it there;
//! - a command outside the sandbox the shell classifier reads as a payment, a send or an access
//!   change;
//! - a command asking to leave the sandbox this once: Full access never widens the sandbox;
//! - a tool that declares nothing, outside the sandbox or able to reach the network: the person
//!   decides once for the bot, as on the auto-review (its "yes" lets it run, never a send or payment the classifier raises);
//!
//! And what still goes to the reviewer: a connector's or plugin's tool that writes and can reach
//! the network (it acts on a server, often with the person's sign-in or a token; a sandbox that
//! holds its files doesn't hold that) while untrusted content is in view, or while Spade's
//! classifier, which may raise it to the person, is off or can't be loaded. Only a plugin server
//! sealed in the sandbox with no network and no credentials of its own is exempt.
//!
//! Pure.

use super::{
    Ask, CHANGES_ACCESS, Call, Effect, OUTSIDE, Place, Route, SENDS_AS_YOU, SPENDS, TAINTED_OUTWARD,
};
use crate::autonomy::{Class, Sensitive};

pub(super) fn route(call: Call<'_>) -> Route {
    if call.effect == Some(Effect::Drive) {
        return match super::persons_place(call) {
            Ok(_) => Route::Run,
            Err(asked) => asked,
        };
    }
    match call.place {
        Place::AsksOutside => {
            return Route::Ask {
                line: OUTSIDE.to_owned(),
                ask: Some(Ask::OutsideSandbox),
            };
        }
        Place::Unsandboxed(Class::Sensitive(kind)) => {
            if let Some(line) = hard_stop(kind) {
                return Route::Ask {
                    line: line.to_owned(),
                    ask: None,
                };
            }
        }
        _ => {}
    }
    // A tool that declares nothing asks once, as on the auto-review; the person's "yes" lets it
    // run below like a declared write, never past the classifier.
    if call.effect.is_none() {
        let route = super::undeclared(call);
        if route != Route::Run {
            return route;
        }
    }
    // An app's tool that writes runs on a server outside any sandbox, often as the person.
    // Sandboxed or not: containing its files doesn't contain what it does as the person.
    if call.remote && call.effect != Some(Effect::Read) {
        if call.tainted {
            return super::review(call, Some(TAINTED_OUTWARD));
        }
        if !call.classifier {
            return super::review(call, Some(NO_CLASSIFIER));
        }
    }
    Route::Run
}

/// What the reviewer is told about an app's write it sees because the classifier can't screen it.
pub const NO_CLASSIFIER: &str = "It writes in one of the person's apps, and Spade's classifier, which would catch a send or a \
     payment, is off.";

/// What the shell classifier reads in a command outside the sandbox that stays the person's.
fn hard_stop(kind: Sensitive) -> Option<&'static str> {
    match kind {
        Sensitive::Payment => Some(SPENDS),
        Sensitive::MessageAsPerson => Some(SENDS_AS_YOU),
        Sensitive::Credentials => Some(CHANGES_ACCESS),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
