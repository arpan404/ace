//! A route's fallback (ADR 0205 §2): which model of a role's ordered list serves a call, when the
//! call moves on to the next one, and what the step records about it. Pure: the server says
//! what each model can do and how each try failed.
//!
//! - The first model that can serve the call serves it: one with every capability the call
//!   needs and a context that holds its prompt.
//! - A call moves on only on a definite sign ([`spade_models::Unserved`]): unreachable, a rate
//!   limit, a used-up quota at once; a server error once its tries with backoff are used up.
//!   Never on a slow answer, a bad answer or a refusal.
//! - A reply stays on the model that served its last step, so one fallback doesn't move the
//!   next step back and forth; the route is read from its start at the next reply.

use serde::{Deserialize, Serialize};
use spade_models::Unserved;

use crate::event::{Event, Known};

/// Why a model of the route didn't serve a step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Unreachable,
    RateLimited,
    Quota,
    ServerError,
    /// The call offers tools and the model can't call them.
    NoTools,
    /// The prompt carries images and the model can't read them.
    NoImages,
    /// The prompt is longer than the model's context.
    TooSmall,
}

impl From<Unserved> for Reason {
    fn from(unserved: Unserved) -> Self {
        match unserved {
            Unserved::Unreachable => Self::Unreachable,
            Unserved::RateLimited => Self::RateLimited,
            Unserved::Quota => Self::Quota,
            Unserved::ServerError => Self::ServerError,
        }
    }
}

/// A model passed over, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Skipped {
    pub model: String,
    pub reason: Reason,
}

/// Which model served a step of `reply` and why the ones before it didn't. Stored right before
/// the step's `step_finished`, only for a bot whose route has more than one model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Served {
    pub reply: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<Skipped>,
    /// The line the reply shows ("Ran on Model B: the local server was off."), when the step ran
    /// on another model than the route's first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
}

/// What a call needs of the model that serves it.
#[derive(Debug, Clone, Copy, Default)]
pub struct Needs {
    pub tools: bool,
    pub images: bool,
    /// The prompt's tokens, estimated.
    pub tokens: u64,
}

/// What a model of the route can do, as the person's endpoints list it.
#[derive(Debug, Clone, Copy, Default)]
pub struct Can {
    pub tools: bool,
    pub images: bool,
    pub context: Option<u64>,
}

/// Why `can` doesn't serve a call that `needs`, if it doesn't. An unknown context fits.
pub fn unfit(needs: Needs, can: Can) -> Option<Reason> {
    if needs.tools && !can.tools {
        return Some(Reason::NoTools);
    }
    if needs.images && !can.images {
        return Some(Reason::NoImages);
    }
    if can.context.is_some_and(|context| context < needs.tokens) {
        return Some(Reason::TooSmall);
    }
    None
}

/// What to do after a try on one model of the route failed with `unserved`, while `more` models
/// follow it and the model has `tries_left` quick tries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum After {
    /// Move to the next model of the route.
    MoveOn,
    /// Not a reason to move: keep to this model as a lone model would.
    Stay,
}

pub fn after(unserved: Option<Unserved>, tries_left: bool, more: bool) -> After {
    match unserved {
        _ if !more => After::Stay,
        Some(Unserved::Unreachable | Unserved::RateLimited | Unserved::Quota) => After::MoveOn,
        Some(Unserved::ServerError) if !tries_left => After::MoveOn,
        _ => After::Stay,
    }
}

/// The model the last step of `reply` was served by, as stored.
pub fn last_served<'a>(events: &'a [Event], reply: &str) -> Option<&'a str> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::StepServed(served)) if served.reply == reply => {
            Some(served.model.as_str())
        }
        _ => None,
    })
}

/// Where in `route` a step of a reply starts: at the model its last step was served by, else
/// at the first.
pub fn start(route: &[String], served: Option<&str>) -> usize {
    served
        .and_then(|model| route.iter().position(|m| m == model))
        .unwrap_or(0)
}

/// The line a step that ran on `model` shows, given the models passed over: `None` when it ran on
/// the route's first model. `name` gives a model's name; `local` says whether it runs on this
/// computer.
pub fn line(
    route: &[String],
    model: &str,
    skipped: &[Skipped],
    name: impl Fn(&str) -> String,
    local: impl Fn(&str) -> bool,
) -> Option<String> {
    if route.first().is_none_or(|first| first == model) && skipped.is_empty() {
        return None;
    }
    let ran = format!("Ran on {}", name(model));
    if skipped.is_empty() {
        return Some(format!("{ran}, like the step before."));
    }
    let why: Vec<String> = skipped
        .iter()
        .map(|skip| {
            let other = name(&skip.model);
            match skip.reason {
                Reason::Unreachable if local(&skip.model) => "the local server was off".to_owned(),
                Reason::Unreachable => format!("{other} couldn't be reached"),
                Reason::RateLimited => format!("{other} was rate limited"),
                Reason::Quota => format!("{other}'s quota is used up"),
                Reason::ServerError => format!("{other}'s server kept failing"),
                Reason::NoTools => format!("{other} can't call tools"),
                Reason::NoImages => format!("{other} can't read images"),
                Reason::TooSmall => format!("the conversation is too long for {other}"),
            }
        })
        .collect();
    Some(format!("{ran}: {}.", why.join("; ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route() -> Vec<String> {
        vec![
            "local/small".to_owned(),
            "work/b".to_owned(),
            "work/c".to_owned(),
        ]
    }

    #[test]
    fn a_call_moves_on_only_on_a_definite_sign_and_a_server_error_only_once_its_tries_are_used() {
        use Unserved::*;
        for (unserved, tries_left, expected) in [
            (Some(Unreachable), true, After::MoveOn),
            (Some(RateLimited), true, After::MoveOn),
            (Some(Quota), true, After::MoveOn),
            (Some(ServerError), true, After::Stay),
            (Some(ServerError), false, After::MoveOn),
            // A slow answer, a bad answer and a refusal carry no sign.
            (None, true, After::Stay),
            (None, false, After::Stay),
        ] {
            assert_eq!(after(unserved, tries_left, true), expected, "{unserved:?}");
        }
        // The route's last model has nowhere to move.
        assert_eq!(after(Some(Unreachable), true, false), After::Stay);
    }

    #[test]
    fn the_first_model_that_can_serve_the_call_is_the_one_with_what_it_needs() {
        let needs = Needs {
            tools: true,
            images: false,
            tokens: 9_000,
        };
        let full = Can {
            tools: true,
            images: true,
            context: Some(200_000),
        };
        assert_eq!(unfit(needs, full), None);
        let no_tools = Can {
            tools: false,
            ..full
        };
        assert_eq!(unfit(needs, no_tools), Some(Reason::NoTools));
        let small = Can {
            context: Some(4_096),
            ..full
        };
        assert_eq!(unfit(needs, small), Some(Reason::TooSmall));
        let unknown = Can {
            context: None,
            ..full
        };
        assert_eq!(unfit(needs, unknown), None);
        let pictures = Needs {
            images: true,
            ..needs
        };
        let blind = Can {
            images: false,
            ..full
        };
        assert_eq!(unfit(pictures, blind), Some(Reason::NoImages));
    }

    #[test]
    fn a_reply_keeps_to_the_model_that_served_its_last_step() {
        let reply = |model: &str, reply: &str| {
            Event::Known(Known::StepServed(Served {
                reply: reply.to_owned(),
                model: model.to_owned(),
                skipped: Vec::new(),
                line: None,
            }))
        };
        let events = vec![reply("work/b", "r1"), reply("work/c", "r0")];
        assert_eq!(start(&route(), last_served(&events, "r1")), 1);
        // A new reply reads its route from the start.
        assert_eq!(start(&route(), last_served(&events, "r2")), 0);
        // A model since taken off the route starts it over.
        assert_eq!(start(&route(), Some("gone/x")), 0);
    }

    #[test]
    fn the_line_says_where_the_step_ran_and_why_the_models_before_it_didnt() {
        let name = |m: &str| m.rsplit('/').next().unwrap_or(m).to_owned();
        let local = |m: &str| m.starts_with("local/");
        let off = [Skipped {
            model: "local/small".to_owned(),
            reason: Reason::Unreachable,
        }];
        assert_eq!(
            line(&route(), "work/b", &off, name, local).as_deref(),
            Some("Ran on b: the local server was off.")
        );
        let both = [
            Skipped {
                model: "local/small".to_owned(),
                reason: Reason::NoTools,
            },
            Skipped {
                model: "work/b".to_owned(),
                reason: Reason::RateLimited,
            },
        ];
        assert_eq!(
            line(&route(), "work/c", &both, name, local).as_deref(),
            Some("Ran on c: small can't call tools; b was rate limited.")
        );
        assert_eq!(line(&route(), "local/small", &[], name, local), None);
        assert_eq!(
            line(&route(), "work/b", &[], name, local).as_deref(),
            Some("Ran on b, like the step before.")
        );
    }
}
