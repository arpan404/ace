//! The skill index a conversation starts with. It is stored as an event before the first model
//! call, so every later prompt repeats the same instructions and stays cached; skills added later
//! are found with `skill_search`.

use std::sync::Arc;
use std::time::Duration;

use spade_core::event::{Event, Known};
use spade_core::skills;

use super::Engine;

/// How long the first reply waits for the skill library before going without an index.
const WAIT: Duration = Duration::from_secs(5);

/// Stores the index if this conversation has none and has not called a model yet. Returns whether
/// it stored one.
pub(super) async fn if_needed(engine: &Arc<Engine>, id: &str, events: &[Event]) -> bool {
    let Some(library) = &engine.skills else {
        return false;
    };
    let begun = events.iter().any(|event| {
        matches!(
            event,
            Event::Known(Known::StepFinished { .. } | Known::SkillsIndexed { .. })
        )
    });
    if begun {
        return false;
    }
    let text = match tokio::time::timeout(WAIT, library.list()).await {
        Ok(Ok(list)) => skills::index(&list),
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
