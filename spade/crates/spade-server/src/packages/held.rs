//! An update or rollback the person accepted while its bot was working (ADR 0200 §6.1: "applies
//! at the bot's next turn, once it is still"). It isn't refused: it is stored under the bot's
//! held-update setting and applied when the bot's turn ends and nothing of it works or waits on
//! the person, or at the next start. The step is keyed by its transaction, so applying it again
//! after a crash does nothing twice; the held record is cleared only once the update committed.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use spade_core::package::Manifest;
use spade_core::package::link::{Link, PackageId};
use spade_store::package_held_key;

use super::apply::{self, Step};
use super::{PackageError, failed, link_of};
use crate::engine::Engine;

/// The accepted step, as stored until the bot is still.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Held {
    pub transaction: String,
    pub package: PackageId,
    pub manifest: Manifest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
}

impl Held {
    fn of(step: &Step) -> Self {
        Self {
            transaction: step.transaction.clone(),
            package: step.package.clone(),
            manifest: step.manifest.clone(),
            time_zone: step.time_zone.clone(),
        }
    }

    fn step(self) -> Step {
        Step {
            manifest: self.manifest,
            package: self.package,
            transaction: self.transaction,
            time_zone: self.time_zone,
        }
    }
}

/// What asking for an update did.
pub enum Asked {
    /// The bot was still: it moved now.
    Applied(Link),
    /// The bot is working: the step waits for its next still moment.
    Held(Link),
}

/// The update held for `bot`, if one is.
pub fn of(engine: &Engine, bot: &str) -> Option<Held> {
    let text = engine.store().setting(&package_held_key(bot)).ok()??;
    serde_json::from_str(&text).ok()
}

fn store(engine: &Engine, bot: &str, held: Option<&Held>) -> Result<(), PackageError> {
    let text = held.map(|held| serde_json::to_string(held).unwrap_or_default());
    engine
        .store()
        .set_setting(&package_held_key(bot), text.as_deref())
        .map_err(failed)
}

/// The person accepted an update or rollback: applied now if the bot is still, else held. A
/// later one replaces one still held: the person accepted that one last.
pub fn ask(engine: &Arc<Engine>, bot: &str, step: Step) -> Result<Asked, PackageError> {
    let held = Held::of(&step);
    match applied(engine, bot, step) {
        Ok(link) => {
            // What waited is older than what the person just accepted.
            if of(engine, bot).is_some() {
                store(engine, bot, None)?;
            }
            Ok(Asked::Applied(link))
        }
        Err(PackageError::Busy(_)) => {
            store(engine, bot, Some(&held))?;
            Ok(Asked::Held(link_of(engine, bot)?))
        }
        Err(error) => Err(error),
    }
}

/// An update applied; a withdrawn bot that moved to another version is resumed, since the
/// version it was paused for is gone.
fn applied(engine: &Arc<Engine>, bot: &str, step: Step) -> Result<Link, PackageError> {
    let withdrawn = link_of(engine, bot)?.withdrawn.is_some();
    let link = apply::update(engine, bot, step)?;
    if withdrawn && link.withdrawn.is_none() {
        engine.resume_agent(bot).map_err(failed)?;
    }
    Ok(link)
}

/// Applies `bot`'s held update if it has one and is still now; else it keeps waiting. One the
/// bot's package can no longer take (it isn't linked, the manifest is refused) is dropped.
pub fn apply_if_still(engine: &Arc<Engine>, bot: &str) {
    let Some(held) = of(engine, bot) else {
        return;
    };
    let transaction = held.transaction.clone();
    match applied(engine, bot, held.step()) {
        Ok(_) => {
            // Only the step that was applied is cleared; one accepted meanwhile stays.
            if of(engine, bot).is_some_and(|now| now.transaction == transaction)
                && let Err(error) = store(engine, bot, None)
            {
                tracing::warn!(%error, %bot, "a held package update applied but stays recorded");
            }
        }
        Err(PackageError::Busy(_)) => {}
        Err(error @ (PackageError::Failed(_) | PackageError::NotFound)) => {
            tracing::warn!(%error, %bot, "a held package update waits for the next still moment");
        }
        Err(error) => {
            tracing::warn!(%error, %bot, "a held package update can't be applied and is dropped");
            let _ = store(engine, bot, None);
        }
    }
}

/// The turn in `conversation` ended: its bot's held update, if any, is applied once it is still.
pub fn turn_ended(engine: &Arc<Engine>, conversation: &str) {
    let Ok(Some(agent)) = engine.store().agent_for_conversation(conversation) else {
        return;
    };
    apply_if_still(engine, &agent.id);
}

/// At start: each held update whose bot is still is applied; the others wait for their turn.
pub fn recover(engine: &Arc<Engine>) {
    let Ok(agents) = engine.store().agents() else {
        return;
    };
    for agent in agents {
        apply_if_still(engine, &agent.id);
    }
}
