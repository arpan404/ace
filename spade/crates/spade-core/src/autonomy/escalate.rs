//! When one of Spade's automated judges stops a call, the person decides (ADR 0163, amendment 3).
//!
//! The reviewer refusing a call (or failing to decide), Spade's classifier raising it, the ADR
//! 0135 review objecting, and the checks that can't vouch for what a command outside the sandbox
//! runs (a reading that isn't whole, one that can't be taken again right before the launch, a
//! file that changed while the call waited) don't refuse the call and tell the bot no. They put it
//! to the person as a request, with the judge's reason in one plain sentence, and the call waits
//! for their answer like any other request.
//!
//! Two refusals are never put to the person: a call that would hand back a secret, and a tool the
//! person already declined for the bot (their remembered "no"). What the OS sandbox blocks is the
//! sandbox's fact, shown as the command's result, and a driving step whose place changed is
//! looked at again by the bot; neither is a judgment, so neither is decided here.

use serde::{Deserialize, Serialize};

use crate::effect::{self, Route};

/// What stopped a call the person now decides on, stored with the request
/// (`approval_requested.stopped`): the card says so, and the answer is held to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stopped {
    /// The reviewer refused it, or couldn't decide on it.
    Reviewer,
    /// The optional second review (ADR 0135) objected, or couldn't decide.
    SecondReview,
    /// Spade's classifier read it as one of the person's effects (ADR 0172).
    Classifier,
    /// Part of what it would run outside the sandbox couldn't be read whole. The person's Allow
    /// once lets it start though the reading is still incomplete at the launch, as long as what
    /// could be read is unchanged.
    Incomplete,
    /// What it runs couldn't be read again right before it started.
    Unread,
    /// A file it runs changed after it was decided on: asked again on the file as it is now.
    Changed,
}

impl Stopped {
    /// Whether the person's answer holds for this call only. A check that couldn't vouch for what
    /// a command runs is answered once: never an Always allow, nor the bot's setting to run its
    /// commands outside. A judge's request keeps the Always allow it offers.
    pub fn once(self) -> bool {
        matches!(self, Self::Incomplete | Self::Unread | Self::Changed)
    }
}

/// A stored `stopped`, read leniently: a word this build doesn't know is none.
pub fn lenient<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Stopped>, D::Error> {
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

/// What stopped a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop<'a> {
    /// The reviewer refused it, with its reason.
    Reviewer(&'a str),
    /// The reviewer failed, timed out or answered what Spade couldn't read: the plain sentence
    /// that says which.
    ReviewerUndecided(&'a str),
    /// Spade's classifier raised it, with the line for the effect it read.
    Classifier(&'a str),
    /// The second review objected, with its reason.
    SecondReview(&'a str),
    /// The second review failed or timed out: the plain sentence that says which.
    SecondReviewUndecided(&'a str),
    /// Part of what it would run outside the sandbox couldn't be read whole.
    IncompleteOutside,
    /// Right before the launch, part of what it runs couldn't be read whole.
    IncompleteAtLaunch,
    /// Right before the launch, what it runs couldn't be read at all.
    UnreadAtLaunch,
    /// A file it runs changed after the call was decided on.
    ChangedAtLaunch,
    /// It would hand back a secret.
    Secret,
    /// The person declined this tool for the bot.
    DeclinedTool,
}

/// Where a stopped call goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settled {
    /// The person decides, with the request's line.
    Ask { line: String, stopped: Stopped },
    /// Not run; the bot is told why.
    Refuse(String),
}

pub fn settle(stop: Stop<'_>) -> Settled {
    let ask = |line: String, stopped| Settled::Ask { line, stopped };
    match stop {
        Stop::Reviewer(reason) => ask(said("The reviewer stopped this", reason), Stopped::Reviewer),
        Stop::ReviewerUndecided(line) => ask(line.to_owned(), Stopped::Reviewer),
        Stop::Classifier(line) => ask(line.to_owned(), Stopped::Classifier),
        Stop::SecondReview(reason) => ask(
            said("The second review stopped this", reason),
            Stopped::SecondReview,
        ),
        Stop::SecondReviewUndecided(line) => ask(line.to_owned(), Stopped::SecondReview),
        Stop::IncompleteOutside => ask(INCOMPLETE_OUTSIDE.to_owned(), Stopped::Incomplete),
        Stop::IncompleteAtLaunch => ask(INCOMPLETE_AT_LAUNCH.to_owned(), Stopped::Incomplete),
        Stop::UnreadAtLaunch => ask(UNREAD_AT_LAUNCH.to_owned(), Stopped::Unread),
        Stop::ChangedAtLaunch => ask(CHANGED_AT_LAUNCH.to_owned(), Stopped::Changed),
        Stop::Secret => Settled::Refuse(super::CREDENTIALS_REFUSED.to_owned()),
        Stop::DeclinedTool => Settled::Refuse(effect::DECLINED_TOOL.to_owned()),
    }
}

/// Where a call goes when part of what it would run outside the sandbox couldn't be read whole:
/// whatever the route, the person decides, told so; a hard refusal (a secret, a declined tool)
/// stays one. Nothing that can't be read whole runs on the rules, a grant or a reviewer.
pub fn incomplete(route: Route) -> Route {
    match route {
        Route::Refuse(why) => Route::Refuse(why),
        Route::Ask { line, ask } => Route::Ask {
            line: format!("{line} {INCOMPLETE_OUTSIDE}"),
            ask,
        },
        Route::Run | Route::Review(_) => Route::Ask {
            line: INCOMPLETE_OUTSIDE.to_owned(),
            ask: None,
        },
    }
}

/// `"<who>: <reason>"`, one sentence, whatever the judge wrote.
fn said(who: &str, reason: &str) -> String {
    let reason = reason.trim();
    if reason.is_empty() {
        return format!("{who} step.");
    }
    let end = if reason.ends_with(['.', '!', '?']) {
        ""
    } else {
        "."
    };
    format!("{who}: {reason}{end}")
}

/// Why the person decides on a command part of which couldn't be read whole.
pub const INCOMPLETE_OUTSIDE: &str = "Part of what this command would run outside the sandbox \
     couldn't be read whole (a script too long, outside its folder or unreadable), so Spade can't \
     check it: you decide.";

/// Why the person is asked again: part of what it runs couldn't be read whole again.
pub const INCOMPLETE_AT_LAUNCH: &str = "Right before it started, part of what this command runs \
     couldn't be read whole again, so Spade can't tell it is what was allowed: you decide.";

/// Why the person is asked again: what it runs couldn't be read again at all.
pub const UNREAD_AT_LAUNCH: &str = "Right before it started, Spade couldn't read again what this \
     command runs, so you decide.";

/// Why the person is asked again: a file it runs changed while it waited.
pub const CHANGED_AT_LAUNCH: &str = "A file this command runs changed after it was checked, so \
     you decide on it as it is now.";

#[cfg(test)]
mod tests;
