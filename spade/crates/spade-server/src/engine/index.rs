//! The skill index in a conversation's standing instructions: the skills its bot used most, then
//! by name. It is stored as an event before the first model call and again after each compaction
//! (the one point the prompt's top changes), so every prompt in between repeats the same
//! instructions and stays cached; skills added meanwhile are found with `skill_search`.

use std::sync::Arc;
use std::time::Duration;

use spade_core::event::{Event, Known};
use spade_core::skills;

use super::Engine;

/// How long the first reply waits for the skill library before going without an index.
const WAIT: Duration = Duration::from_secs(5);

/// Stores the index if none is in effect since the conversation began or last compacted, before
/// the next model call. Returns whether it stored one.
pub(super) async fn if_needed(engine: &Arc<Engine>, id: &str, events: &[Event]) -> bool {
    let Some(library) = &engine.skills else {
        return false;
    };
    if !skills::index_due(events) {
        return false;
    }
    let agent = engine.agent_of(id);
    let uses = agent
        .as_ref()
        .map(|agent| library.uses(agent))
        .unwrap_or_default();
    let text = match tokio::time::timeout(WAIT, library.list_for(agent.as_deref())).await {
        Ok(Ok(list)) => skills::index(&list, &uses),
        Ok(Err(error)) => {
            tracing::warn!(%error, "no skill index for this conversation");
            String::new()
        }
        Err(_) => {
            tracing::warn!("the skill library did not answer in time; no index");
            String::new()
        }
    };
    match engine.record(id, &Event::Known(Known::SkillsIndexed { text })) {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, "could not store the skill index");
            false
        }
    }
}
