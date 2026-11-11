//! Compaction in the engine: automatic before a model call once the prompt passes the high mark,
//! or on request. The summary comes from the conversation's own model on its cached prompt.

use std::sync::Arc;

use spade_core::Event;
use spade_core::compaction::{self, Plan};
use spade_core::context::{self, SYSTEM};
use spade_core::event::Known;
use spade_models::Message;

use super::Engine;

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

/// The budget: the smaller of the model's context window and Spade's cap.
fn budget(engine: &Engine, model: &str) -> u32 {
    let window = engine
        .models
        .catalog()
        .resolve(model)
        .and_then(|r| r.model.context)
        .map_or(u32::MAX, |c| u32::try_from(c).unwrap_or(u32::MAX));
    window.min(engine.limits.context_budget)
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
    run(engine, id, model, events, plan, None).await;
    true
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
    run(engine, id, model, &events, Plan { keep_from }, focus).await;
    Ok(true)
}

async fn run(
    engine: &Arc<Engine>,
    id: &str,
    model: &str,
    events: &[Event],
    plan: Plan,
    focus: Option<&str>,
) {
    // The summary request goes after the whole current prompt, with the same tools, so its input
    // is cache reads. Typed output is not used: it would change the request and miss the cache.
    let images = engine.images_for(model);
    let mut prompt =
        context::prompt_with(SYSTEM, engine.tools.registry().offered(), events, &images);
    prompt.messages.push(Message::Person {
        text: compaction::request(focus),
        images: Vec::new(),
    });
    let carried = compaction::carried_out(events, plan.keep_from, &engine.tools.registry());
    let written = match engine.models.chat(model, &prompt).await {
        Ok(reply) => {
            engine.pay(id, model, &reply.usage);
            if reply.calls.is_empty() {
                compaction::parse_summary(&reply.text)
            } else {
                None
            }
        }
        Err(error) => {
            if let Some(usage) = error.usage() {
                engine.pay(id, model, &usage);
            }
            tracing::warn!(%error, "summary failed; leaving older turns out instead");
            None
        }
    };
    let summary = match written {
        Some(summary) => compaction::render(&summary, &carried),
        None => {
            let mut text = LEFT_OUT.to_owned();
            if !carried.is_empty() {
                text.push_str("\n\nAlready carried out (do not repeat):\n");
                for action in &carried {
                    text.push_str(&format!("- {action}\n"));
                }
            }
            text
        }
    };
    let event = Event::Known(Known::ContextCompacted {
        summary,
        keep_from: plan.keep_from,
        tokens_before: last_prompt_tokens(events),
        images_left_out: Some(context::images_to_leave_out(events, plan.keep_from)),
    });
    if let Err(error) = engine.record(id, &event) {
        tracing::error!(%error, "could not store a compaction");
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
