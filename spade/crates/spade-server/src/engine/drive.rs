//! The engine's side of driving steps (ADR 0171, amendment 3): where a step acts, asked of ace
//! right before the gate decides and again right before the step runs, whether a drive grant
//! covers that place, and the grant a "for this bot" answer makes. What to ask and how to read
//! the answer is `spade_core::effect::drive`; this is the I/O around it.

use std::time::Duration;

use serde_json::Value;
use spade_core::effect::drive::{self, Lookup, Place, Step};
use spade_core::grant::Action;

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

    /// Whether a drive grant of the bot that owns `conversation` covers `place`: an app by its
    /// id, a site by its host, never a device.
    pub(super) fn drive_granted(&self, conversation: &str, place: &Place) -> bool {
        let (Some(security), Some(agent)) = (self.security(), self.agent_of(conversation)) else {
            return false;
        };
        let action = match place {
            Place::App { id, .. } => Action::DriveApp { app: id },
            Place::Site { host, .. } => Action::DriveSite { host },
            Place::DeviceApp { .. } | Place::Device { .. } => return false,
        };
        spade_core::grant::allowed(&security.effective_grants(&agent), &action)
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

    /// Keeps where the gate found the step `key` acts, to check again right before it runs.
    pub(super) fn decide_place(&self, key: &str, place: Place) {
        self.drive_places
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key.to_owned(), place);
    }

    /// Where the gate found the step `key` acts, taken (each call runs once).
    pub(super) fn take_place(&self, key: &str) -> Option<Place> {
        self.drive_places
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key)
    }

    /// Whether the step `key` still acts where it was decided on, read from ace right before
    /// it runs. A step decided on with no place (the person allowed it so) has nothing to keep.
    pub(super) async fn still_there(
        &self,
        conversation: &str,
        key: &str,
        name: &str,
        arguments: &Value,
    ) -> bool {
        let Some(decided) = self.take_place(key) else {
            return true;
        };
        let now = self.drive_step(conversation, key, name, arguments).await;
        now.place.as_ref() == Ok(&decided)
    }
}
