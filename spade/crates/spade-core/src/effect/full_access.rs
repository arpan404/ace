//! Where a call goes for a bot in Full access (ADR 0163, amendment 2), once [`super::route`] has
//! applied the hard stops every mode keeps: a secret refused; a payment, a send in the person's
//! name, an access change and an effect Spade doesn't know asking the person. Nothing here sends a
//! call to the reviewer, and untrusted content in view adds no ask. What still asks:
//!
//! - a driving step in a place where a step could send, pay or change access (mail and chat, money,
//!   passwords, sign-in and account pages, settings, social sites, a browser driven through the
//!   screen), on a simulator or device or an app that shows one, or where Spade can't tell where
//!   it acts or ace can't hold it there;
//! - a command outside the sandbox the shell classifier reads as a payment, a send or an access
//!   change;
//! - a command asking to leave the sandbox this once: Full access never widens the sandbox;
//! - an undeclared tool the person declined for the bot stays declined.
//!
//! Pure.

use super::{
    Ask, CHANGES_ACCESS, Call, DECLINED_TOOL, Effect, OUTSIDE, Place, Route, SENDS_AS_YOU, SPENDS,
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
    if call.effect.is_none() && call.place != Place::Sandbox && call.remembered == Some(false) {
        return Route::Refuse(DECLINED_TOOL.to_owned());
    }
    Route::Run
}

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
