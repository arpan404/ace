//! Compaction in the engine: automatic before a model call once the prompt passes the high mark,
//! or on request. The summary comes from the conversation's own model on its cached prompt, or
//! from the `compact` role's model when that fits and costs less (ADR 0162).

use std::sync::Arc;

use spade_core::Event;
use spade_core::compaction::{self, Budget, Plan};
use spade_core::context;
use spade_core::event::Known;
use spade_models::Message;

use super::Engine;

/// The summary used when the model cannot write one: older turns are left out, visibly.
const LEFT_OUT: &str = "Earlier messages were left out to fit the model's context; ask the person \
                        if something from before is needed.";

/// The budget: the smallest context window of the models that may serve the step (the turn's
/// model and its fallbacks; the fallback size for a model that doesn't say), capped only by
/// `SPADE_CONTEXT_TOKENS`, and the lower cap the person may set (`context_tokens`, ADR 0216).
fn budget(engine: &Engine, id: &str, model: &str) -> Budget {
    let route = engine.step_route(id, model);
    let window = std::iter::once(model)
        .chain(route.iter().map(String::as_str))
        .map(|m| {
            let window = engine.models.resolve(m).and_then(|(_, m)| m.context);
            budget_for(window, &engine.limits)
        })
        .min()
        .unwrap_or(engine.limits.context_fallback);
    Budget {
        window,
        working: engine.context_tokens(id).unwrap_or(u32::MAX),
    }
}

fn budget_for(window: Option<u64>, limits: &super::Limits) -> u32 {
    window
        .map_or(limits.context_fallback, |c| {
            u32::try_from(c).unwrap_or(u32::MAX)
        })
        .min(limits.context_budget)
}

/// Compacts if the next request's prompt, as estimated, has reached the budget. Returns whether
/// a compaction was stored: one that could not be stored leaves the step to go on, never to
/// pay for the same summary again in a loop.
pub(super) async fn if_needed(
    engine: &Arc<Engine>,
    id: &str,
    model: &str,
    events: &[Event],
) -> bool {
    let budget = budget(engine, id, model);
    let estimate = compaction::prompt_estimate(events);
    let Some(plan) = compaction::plan_within(events, estimate, budget) else {
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
        Err("the compaction could not be stored".to_owned())
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
    let mut ledger = compaction::ledger(events, plan.keep_from, &engine.registry_for(id));
    // Nobody but the bot writes in a helper's conversation: its brief is the bot's words, never
    // kept as the person's (ADR 0216).
    if engine.helper_of(id).is_some() {
        ledger.said.clear();
        ledger.said_earlier = 0;
    }
    // Asked knowing what is kept of the person's words, so what is cut is summarised.
    prompt.messages.push(Message::Person {
        text: compaction::request_keeping(focus, &ledger),
        images: Vec::new(),
    });
    // Paid for like every model call (ADR 0135).
    let hint = super::ledger::turn_hint(events);
    // The `compact` role's model when it fits and costs less (ADR 0162).
    let turn_model = model;
    let model = &engine.compact_model(id, model, &prompt, hint);
    // On the turn's own model it thinks as the turn did, so the request still reads the turn's
    // cache (a changed thinking setting misses it); on the `compact` model, as that role does.
    prompt.effort = if model == turn_model {
        engine.step_effort(id)
    } else {
        engine.role_effort(id, spade_core::routing::Role::Compact)
    };
    let admitted = engine
        .admit(id, model)
        .for_role(spade_core::routing::Role::Compact);
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
    // The summary, the person's own words kept whole and the writes carried out (ADR 0216).
    let summary = compaction::written(written.as_ref(), LEFT_OUT, &ledger);
    let event = Event::Known(Known::ContextCompacted {
        summary,
        keep_from: plan.keep_from,
        tokens_before: compaction::prompt_estimate(events),
        images_left_out: Some(context::images_to_leave_out(events, plan.keep_from)),
        untrusted,
        carried: Some(ledger),
        // The person's asks as they stand, so a fold after this starts here (ADR 0215).
        asks: Some(Box::new(engine.asks_of(id, events))),
    });
    match engine.record(id, &event) {
        Ok(_) => {
            // The prompt's top may change here, so the bot's learned pins are frozen again now
            // (docs/design.md, Caching; docs/harness.md, Tools).
            engine.refreeze_pins(id);
            true
        }
        Err(error) => {
            tracing::error!(%error, "could not store a compaction");
            false
        }
    }
}

/// Stores the next batch of aged tool results when one is due (ADR 0216). Returns whether it
/// did; a store that fails ages nothing, so the step goes on as it was.
pub(super) fn age_if_due(engine: &Engine, id: &str, events: &[Event]) -> bool {
    // Off unless the person turned it on: models see full output by default.
    if !engine.ages_results(id) {
        return false;
    }
    // A stub points at `history_read`; a conversation that cannot run it keeps its results whole.
    let readable = engine
        .registry_for(id)
        .get(spade_core::aging::READ_BACK)
        .is_some();
    if !readable {
        return false;
    }
    let Some(before) = spade_core::aging::due(events) else {
        return false;
    };
    match engine.record(id, &Event::Known(Known::ResultsAged { before })) {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, "could not store aged results");
            false
        }
    }
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
