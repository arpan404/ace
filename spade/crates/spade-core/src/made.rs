//! Bots a bot makes for the person (ADR 0161, amendment 1): a standing bot from `bot_create`
//! with `kind: standing`, and a bot added to a club with `club_add`. Who may, when the person
//! decides, and whether a made bot has acted outside itself yet (Undo removes one that hasn't).
//! Pure: the engine brings the setting, the taint and the events.

use crate::effect::{self, Effect, Route};
use crate::event::{Event, Known};
use crate::tools::Risk;
use crate::tree::BOT_CREATE;

/// Adds a bot of this machine to a club the caller is a member of.
pub const CLUB_ADD: &str = "club_add";

/// Whether a bot may make bots for the person: its per-bot setting `may_create_bots`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum May {
    Yes,
    /// The person agrees to each one.
    Ask,
    No,
}

impl May {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Yes => "yes",
            Self::Ask => "ask",
            Self::No => "no",
        }
    }

    pub fn parse(word: &str) -> Option<Self> {
        match word.trim() {
            "yes" => Some(Self::Yes),
            "ask" => Some(Self::Ask),
            "no" => Some(Self::No),
            _ => None,
        }
    }

    /// The setting a bot has until the person sets one: Spade, the main bot, may; others ask.
    pub const fn default_for(main: bool) -> Self {
        if main { Self::Yes } else { Self::Ask }
    }
}

pub const TAINTED: &str = "Content from outside the conversation is in view, so you decide \
whether it makes a bot.";
pub const ASKS: &str = "It wants to make a bot for you, so you decide.";
pub const ASKS_CLUB: &str = "It wants to add a bot to a club, so you decide.";
pub const REFUSED: &str = "Refused: this bot may not make bots. The person can allow it in its \
profile (May create bots).";

/// Whether `bot_create` makes a standing bot (its `kind` is `standing`), not a worker.
pub fn standing(arguments: &serde_json::Value) -> bool {
    arguments.get("kind").and_then(|k| k.as_str()) == Some("standing")
}

/// Where a call that makes a bot for the person goes; `None` for any other call (a worker's
/// `bot_create` keeps ADR 0161's route). Decided before access levels, so Full access never
/// skips the person, and "always" never covers it.
pub fn route(tool: &str, arguments: &serde_json::Value, tainted: bool, may: May) -> Option<Route> {
    let ask = |line: &str| Route::Ask {
        line: line.to_owned(),
        ask: None,
    };
    let club = tool == CLUB_ADD;
    let makes = tool == BOT_CREATE && standing(arguments);
    if !(club || makes) {
        return None;
    }
    Some(match (may, tainted) {
        (May::No, _) => Route::Refuse(REFUSED.to_owned()),
        (_, true) => ask(TAINTED),
        (May::Ask, false) => ask(if club { ASKS_CLUB } else { ASKS }),
        (May::Yes, false) => Route::Run,
    })
}

/// Whether a bot has acted outside itself: any step it started that does more than read or
/// change its own things (its folder, notes, plan, routines). The effect the gate recorded on the
/// step decides; an older step without one is read by its tool and risk. A step Spade can't say
/// that of counts as acting outside, so Undo never deletes a bot that may have.
pub fn acted_outside(events: &[Event]) -> bool {
    events.iter().any(|event| match event {
        Event::Known(Known::ToolStarted {
            name, risk, effect, ..
        }) => {
            let effect = effect.or_else(|| effect::builtin(name, risk.unwrap_or(Risk::Write)));
            !matches!(effect, Some(Effect::Read | Effect::WriteLocal))
        }
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn started(name: &str, risk: Option<Risk>) -> Event {
        declared(name, risk, None)
    }

    fn declared(name: &str, risk: Option<Risk>, effect: Option<Effect>) -> Event {
        Event::Known(Known::ToolStarted {
            reply: "r".into(),
            call_id: "c".into(),
            name: name.into(),
            risk,
            background: false,
            effect,
        })
    }

    #[test]
    fn making_a_standing_bot_follows_its_setting_and_asks_with_untrusted_content_in_view() {
        let standing = json!({ "kind": "standing", "name": "Research", "task": "Read" });
        let worker = json!({ "name": "Part", "task": "Read" });
        assert_eq!(
            route(BOT_CREATE, &standing, false, May::Yes),
            Some(Route::Run)
        );
        assert!(matches!(
            route(BOT_CREATE, &standing, false, May::Ask),
            Some(Route::Ask { line, .. }) if line == ASKS
        ));
        assert!(matches!(
            route(BOT_CREATE, &standing, true, May::Yes),
            Some(Route::Ask { line, .. }) if line == TAINTED
        ));
        assert!(matches!(
            route(BOT_CREATE, &standing, false, May::No),
            Some(Route::Refuse(_))
        ));
        // A worker keeps its own route; club_add follows the same rules.
        assert_eq!(route(BOT_CREATE, &worker, true, May::No), None);
        assert!(matches!(
            route(CLUB_ADD, &json!({}), false, May::Ask),
            Some(Route::Ask { line, .. }) if line == ASKS_CLUB
        ));
        assert_eq!(May::default_for(true), May::Yes);
        assert_eq!(May::default_for(false), May::Ask);
    }

    #[test]
    fn only_steps_outside_the_bot_count_as_having_acted() {
        assert!(!acted_outside(&[]));
        assert!(!acted_outside(&[
            started("web_search", Some(Risk::Read)),
            started("workspace_write", Some(Risk::Write)),
            started("memory_save", Some(Risk::Memory)),
        ]));
        assert!(acted_outside(&[started("send_message", Some(Risk::Write))]));
        assert!(acted_outside(&[started("gmail__send", None)]));
        // What the gate recorded decides: an app's read is no act outside, its send is.
        assert!(!acted_outside(&[declared(
            "notion__search",
            Some(Risk::Write),
            Some(Effect::Read)
        )]));
        assert!(acted_outside(&[declared(
            "slack__post",
            Some(Risk::Read),
            Some(Effect::SendAsPerson)
        )]));
    }
}
