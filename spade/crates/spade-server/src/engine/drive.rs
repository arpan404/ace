//! The engine's side of driving steps (ADR 0171, amendments 3 and 7): where a step acts, asked of
//! ace right before the gate decides and again right before the step runs, the bot's
//! Permissions that decide it, and the grant an older "for this bot" answer makes. What to ask and how to read
//! the answer is `spade_core::effect::drive`; this is the I/O around it.

use std::time::Duration;

use serde_json::Value;
use spade_core::effect::drive::{self, Lookup, Place, Step};
use spade_core::permission::{Held, never};

use super::Engine;

/// How long Spade waits for ace to say where a step acts before it can't tell.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(15);

/// Why a step that was checked doesn't run: where it acts changed since.
pub(super) const MOVED: &str = "Not run: the page or app it acts in changed since Spade checked \
     it. Look at it again, then act.";

impl Engine {
    /// Where the driving step `name` acts now, asking ace (as the bot, with the call's routing)
    /// when the call doesn't name its place. An answer ace can't give leaves no place.
    pub(super) async fn drive_step(
        &self,
        conversation: &str,
        key: &str,
        name: &str,
        arguments: &Value,
    ) -> Step {
        let (tool, asked) = match drive::lookup(name, arguments) {
            Lookup::Named(step) => return step,
            Lookup::Ask { tool, arguments } => (tool, arguments),
        };
        let answer = match self.tools.get_for(conversation, tool) {
            Some(lookup) => {
                match tokio::time::timeout(LOOKUP_TIMEOUT, lookup.run(key, asked)).await {
                    Ok(output) if !output.is_error => Some(output.content),
                    _ => None,
                }
            }
            None => None,
        };
        drive::read(name, arguments, answer.as_deref())
    }

    /// The Permissions of the bot that owns `conversation` (ADR 0171, amendment 7), and the
    /// machine's never-use list; the defaults (driving off) where Spade has no security settings.
    pub(super) fn permits(&self, conversation: &str) -> (Held, Vec<String>) {
        match (self.security(), self.agent_of(conversation)) {
            (Some(security), Some(agent)) => (security.permits(&agent), security.never_apps()),
            _ => (Held::default(), never::default_list()),
        }
    }

    /// Allows driving `place` for the bot that owns `conversation`, as the person answered a
    /// driving step's request. Refused (and logged) for a sensitive place, a device, or one a
    /// worker's parent lacks.
    pub(super) fn allow_driving(&self, conversation: &str, place: &Place) {
        let (Some(security), Some(agent), Some(scope)) =
            (self.security(), self.agent_of(conversation), place.grant())
        else {
            return;
        };
        if let Err(error) = security.add_grant(&agent, scope, spade_core::grant::BY_PERSON) {
            tracing::warn!(%error, %agent, "driving the app was not allowed for the bot");
        }
    }

    /// Keeps where the gate found the step `key` acts, to check again right before it runs;
    /// `reviewer_only` when no person let it run (it then runs only where ace holds it there).
    pub(super) fn decide_place(&self, key: &str, place: Place, reviewer_only: bool) {
        self.drive_places
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key.to_owned(), (place, reviewer_only));
    }

    /// The arguments the step `key` runs with, when it still acts where it was decided on: read
    /// from ace right before it runs, and held to that place inside ace too (`expect`, where the
    /// tool takes it), so ace refuses the step if the page or app moves on while it waits in
    /// ace's queue. `Err` with why it doesn't run: the place changed, or ace can't hold a step
    /// only the reviewer let run. A step decided on with no place (the person allowed it so)
    /// runs as it is.
    pub(super) async fn bind_place(
        &self,
        conversation: &str,
        key: &str,
        name: &str,
        arguments: Value,
    ) -> Result<Value, &'static str> {
        let decided = self
            .drive_places
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key);
        let Some((decided, reviewer_only)) = decided else {
            return Ok(arguments);
        };
        let now = self.drive_step(conversation, key, name, &arguments).await;
        if now.place.as_ref() != Ok(&decided) {
            return Err(MOVED);
        }
        drive::bind(
            name,
            arguments,
            &decided,
            self.takes_expect(conversation, name),
            reviewer_only,
        )
    }

    /// Whether ace's tool `name` takes `expect` (an ace from before it doesn't).
    pub(super) fn takes_expect(&self, conversation: &str, name: &str) -> bool {
        self.tools.get_for(conversation, name).is_some_and(|tool| {
            tool.def()
                .spec
                .schema
                .pointer("/properties/expect")
                .is_some()
        })
    }
}
