//! Compaction in the engine: automatic before a model call once the prompt passes the high mark,
//! or on request. The summary comes from the conversation's own model on its cached prompt, or
//! from the `compact` role's model when that fits and costs less (ADR 0162).

use std::sync::Arc;

use spade_core::Event;
use spade_core::compaction::{self, Plan};
use spade_core::context;
use spade_core::event::Known;
use spade_models::Message;

use super::Engine;

/// What compacting by hand answers when a cap was reached as it was about to ask the model.
pub(super) const AT_CAP: &str = "the bot is at a spending cap";

/// The summary used when the model cannot write one: older turns are left out, visibly.
const LEFT_OUT: &str = "Earlier messages were left out to fit the model's context; ask the person \
                        if something from before is needed.";

/// The prompt size the endpoint last reported, from the newest finished step.
fn last_prompt_tokens(events: &[Event]) -> u32 {
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            Event::Known(Known::StepFinished { usage, .. }) => usage.input,
            _ => None,
        })
        .unwrap_or(0)
}

/// The budget: the model's own context window (or the fallback for a model that doesn't say),
/// capped only by a budget the person set.
fn budget(engine: &Engine, model: &str) -> u32 {
    let window = engine.models.resolve(model).and_then(|(_, m)| m.context);
    budget_for(window, &engine.limits)
}

fn budget_for(window: Option<u64>, limits: &super::Limits) -> u32 {
    window
        .map_or(limits.context_fallback, |c| {
            u32::try_from(c).unwrap_or(u32::MAX)
        })
        .min(limits.context_budget)
}

/// Compacts if the prompt has reached the high mark. Returns whether it did.
pub(super) async fn if_needed(
    engine: &Arc<Engine>,
    id: &str,
    model: &str,
    events: &[Event],
) -> bool {
    let Some(plan) = compaction::plan(events, last_prompt_tokens(events), budget(engine, model))
    else {
        return false;
    };
    run(engine, id, model, events, plan, None).await
}

/// Compacts now, keeping only the latest turn, with an optional focus for the summary.
pub(super) async fn now(
    engine: &Arc<Engine>,
    id: &str,
    model: &str,
    focus: Option<&str>,
) -> Result<bool, String> {
    let events = engine.load(id).map_err(|e| e.to_string())?;
    let already = events.iter().rev().find_map(|e| match e {
        Event::Known(Known::ContextCompacted { keep_from, .. }) => Some(*keep_from),
        _ => None,
    });
    let Some(keep_from) = compaction::safe_starts(&events, already).last().copied() else {
        return Ok(false);
    };
    if run(engine, id, model, &events, Plan { keep_from }, focus).await {
        Ok(true)
    } else {
        Err(AT_CAP.to_owned())
    }
}

async fn run(
    engine: &Arc<Engine>,
    id: &str,
    model: &str,
    events: &[Event],
    plan: Plan,
    focus: Option<&str>,
) -> bool {
    super::plugin_hooks::before_compact(engine, id, events, plan.keep_from).await;
    // The summary request goes after the whole current prompt, with the same tools, so its input
    // is cache reads. Typed output is not used: it would change the request and miss the cache.
    let images = engine.images_for(model);
    let system = engine.system_for(id);
    let mut prompt =
        context::prompt_with(&system, engine.offered_for(id), events, &images).session(id);
    prompt.messages.push(Message::Person {
        text: compaction::request(focus),
        images: Vec::new(),
    });
    let ledger = compaction::ledger(events, plan.keep_from, &engine.registry_for(id));
    let carried = compaction::lines(&ledger);
    // Admitted like every model call (ADR 0135); at a cap nothing is compacted or spent.
    // It waits while only calls still running stand in the way.
    let hint = super::ledger::turn_hint(events);
    // The `compact` role's model when it fits and costs less (ADR 0162).
    let model = &engine.compact_model(id, model, &prompt, hint);
    let Ok(admitted) = engine.admit_waiting(id, model, &prompt, hint).await else {
        return false;
    };
    let admitted = admitted.for_role(spade_core::routing::Role::Compact);
    let written = match engine.models.chat(model, &prompt).await {
        Ok(reply) => {
            admitted.settle(&reply.usage);
            if reply.calls.is_empty() {
                compaction::parse_summary(&reply.text)
            } else {
                None
            }
        }
        Err(error) => {
            admitted.settle_if(error.usage());
            tracing::warn!(%error, "summary failed; leaving older turns out instead");
            None
        }
    };
    // Facts drawn from untrusted text are only suggested to the person, never kept straight.
    let untrusted = spade_core::memory::untrusted_span(events, &engine.registry_for(id));
    if let Some(summary) = &written {
        super::memory::keep_extracted(engine, id, &summary.notes, untrusted);
    }
    let summary = match written {
        Some(summary) => compaction::render(&summary, &carried),
        None => {
            let mut text = LEFT_OUT.to_owned();
            text.push('\n');
            text.push_str(&compaction::carried_section(&carried));
            text
        }
    };
    let event = Event::Known(Known::ContextCompacted {
        summary,
        keep_from: plan.keep_from,
        tokens_before: last_prompt_tokens(events),
        images_left_out: Some(context::images_to_leave_out(events, plan.keep_from)),
        untrusted,
        carried: Some(ledger),
    });
    if let Err(error) = engine.record(id, &event) {
        tracing::error!(%error, "could not store a compaction");
    }
    true
}

/// The model this conversation uses: its latest turn's.
pub(super) fn conversation_model(engine: &Engine, id: &str) -> Option<String> {
    let events = engine.load(id).ok()?;
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ReplyStarted { model, .. }) => Some(model.clone()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_budget_is_the_models_own_window_unless_the_person_set_a_smaller_one() {
        let limits = super::super::Limits::default();
        assert_eq!(budget_for(Some(1_000_000), &limits), 1_000_000);
        assert_eq!(budget_for(Some(128_000), &limits), 128_000);
        assert_eq!(
            budget_for(None, &limits),
            200_000,
            "a model that doesn't say"
        );
        let capped = super::super::Limits {
            context_budget: 300_000,
            ..limits
        };
        assert_eq!(budget_for(Some(1_000_000), &capped), 300_000);
    }
}
