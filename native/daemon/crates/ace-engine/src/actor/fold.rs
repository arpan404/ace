// SPDX-License-Identifier: Apache-2.0
//! The fold of one batch (`actor.ts:353`–`:528`): what the mailbox runs for a sealed batch. The
//! translation and the streaming answer are computed once and reused by a retry, because
//! translators keep state and a retried batch must not stream its facts twice.

use crate::actor::deps::{ActorDeps, ActorTranslator, TranslatedFrame};
use crate::actor::mailbox::BatchOp;
use crate::actor::state::FrameRef;
use crate::actor::{flow, leases, timer};
use crate::{Core, EngineError, ThreadId};
use ace_json::Value;
use std::rc::Rc;

/// A batch's facts and the Cursor frame records they need, without writing anything.
#[derive(Default, Clone)]
pub struct Translation {
    pub facts: Vec<Value>,
    pub journal: Vec<Value>,
}

fn text<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    match value {
        Value::Object(map) => match map.get(name) {
            Some(Value::String(text)) => Some(text.as_str()),
            _ => None,
        },
        _ => None,
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(name),
        _ => None,
    }
}

fn is_process_exit(fact: &Value) -> bool {
    text(fact, "type") == Some("process.exited")
}

/// Whether the fact moves the queue (`actor.ts:402`–`:413`).
fn moves_queue(fact: &Value) -> bool {
    matches!(
        text(fact, "type"),
        Some(
            "turn.started"
                | "input.admitted"
                | "turn.ended"
                | "process.exited"
                | "queue.changed"
                | "limit.cleared"
                | "interaction.closed"
                | "background.ended"
                | "retry"
        )
    )
}

/// Whether the fact is a tool boundary (`actor.ts:382`).
fn tool_boundary(fact: &Value) -> bool {
    if text(fact, "type") == Some("background.started") {
        return true;
    }
    if text(fact, "type") != Some("item.upsert") {
        return false;
    }
    field(fact, "draft").and_then(|draft| text(draft, "type")) == Some("tool_call")
}

/// `fold_batch` (`actor.ts:367`–`:426`).
pub fn fold_batch(core: &Rc<Core>, thread: &ThreadId, op: &mut BatchOp) -> Result<(), EngineError> {
    let deps = core.actor_deps.borrow().clone();
    let generation = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .map(|actor| actor.generation)
        })?
        .unwrap_or(0);
    let live: Vec<&FrameRef> = op
        .frames
        .iter()
        .filter(|pending| pending.generation == generation)
        .map(|pending| &pending.frame)
        .collect();
    let sdk = op
        .frames
        .iter()
        .filter(|pending| pending.generation == generation)
        .any(|pending| match &pending.frame {
            FrameRef::Js { sdk, .. } => *sdk,
            FrameRef::Native(frame) => frame.channel == "sdk",
        });
    let route = deps.repo.route(core, thread)?;
    let cursor_sdk = route.provider == "cursor" && route.backend.as_deref() == Some("cursor-sdk");
    let mut memory = std::mem::take(&mut op.memory);
    let outcome = (|| -> Result<(), EngineError> {
        if memory.status_before.is_none() {
            memory.status_before = Some(deps.repo.status(core, thread)?);
        }
        let now = core.ports.now();
        let mut translated = match memory.translated.take() {
            Some(translated) => translated,
            None => translate_batch(core, &deps, thread, &live, cursor_sdk, generation)?,
        };
        let facts = std::mem::take(&mut translated.facts);
        if !translated.journal.is_empty() {
            // The record rolls back with the rest, so every attempt writes it again.
            deps.repo.cursor_record(core, thread, &translated.journal)?;
        }
        let boundary = facts.iter().any(tool_boundary);
        let command_running = if boundary {
            deps.repo.running_foreground_command(core, thread)?
        } else {
            false
        };
        // A streamable stretch goes to the live buffer without a transaction of its own.
        let streamed = match memory.streamed {
            Some(streamed) => streamed,
            None => {
                let answer = !cursor_sdk && deps.repo.stream(core, thread, &facts, now)?;
                memory.streamed = Some(answer);
                answer
            }
        };
        let settle = |core: &Rc<Core>, streamed: bool| -> Result<(), EngineError> {
            if streamed {
                timer::schedule(core, thread);
            } else {
                apply(core, thread, &facts)?;
            }
            if sdk
                && facts.iter().any(|fact| {
                    is_process_exit(fact)
                        && !matches!(field(fact, "deliberate"), Some(Value::Bool(true)))
                })
            {
                deps.links.abort_session(core, thread, false);
            }
            let status_after = deps.repo.status(core, thread)?;
            let command_after = if boundary {
                deps.repo.running_foreground_command(core, thread)?
            } else {
                false
            };
            if memory.status_before.as_ref() != Some(&status_after)
                || (boundary && command_running != command_after)
                || facts.iter().any(moves_queue)
            {
                sync_queue(core, thread)?;
                deps.links.wake(core, thread);
            }
            Ok(())
        };
        // An SDK batch's control facts and its queue sync commit together.
        if sdk && !streamed && !cursor_sdk {
            core.store.atomic(|_tx| settle(core, streamed))?;
        } else {
            settle(core, streamed)?;
        }
        translated.facts = facts;
        memory.translated = Some(translated);
        Ok(())
    })();
    op.memory = memory;
    outcome
}

/// `translateBatch` (`actor.ts:448`): one translator call for the batch, then the per-frame steps.
fn translate_batch(
    core: &Rc<Core>,
    deps: &Rc<ActorDeps>,
    thread: &ThreadId,
    frames: &[&FrameRef],
    cursor_sdk: bool,
    generation: u64,
) -> Result<Translation, EngineError> {
    let now = core.ports.now();
    let mut taken = deps.take_translator(thread);
    let translated = match &mut taken {
        Some((_, ActorTranslator::Js(js))) => js.translate_batch(frames, now),
        Some((_, ActorTranslator::Native(native))) => {
            let mut out = Vec::with_capacity(frames.len());
            for frame in frames {
                match frame {
                    FrameRef::Native(frame) => {
                        let facts = native.translate(frame, now as i64);
                        out.push(TranslatedFrame {
                            facts: facts
                                .into_iter()
                                .filter_map(crate::actor::native::fact_to_value)
                                .collect(),
                            diagnostics: native
                                .take_diagnostics()
                                .into_iter()
                                .map(|line| Value::String(line.into()))
                                .collect(),
                            data: Some(frame.data.to_value()),
                        });
                    }
                    FrameRef::Js { .. } => out.push(TranslatedFrame::default()),
                }
            }
            Ok(out)
        }
        None => Ok(frames.iter().map(|_| TranslatedFrame::default()).collect()),
    };
    deps.return_translator(thread, generation, taken);
    let translated = translated?;
    let mut journal = Vec::new();
    let mut facts = Vec::with_capacity(frames.len());
    for (frame, entry) in frames.iter().zip(translated) {
        let sdk = match frame {
            FrameRef::Js { sdk, .. } => *sdk,
            FrameRef::Native(frame) => frame.channel == "sdk",
        };
        let data = entry.data.clone().or_else(|| match frame {
            FrameRef::Native(frame) => Some(frame.data.to_value()),
            FrameRef::Js { .. } => None,
        });
        if sdk
            && cursor_sdk
            && let Some(data) = &data
        {
            let begins_turn = text(data, "kind") == Some("send")
                && deps.repo.quiescent(core, thread).unwrap_or(false);
            journal.push(ace_json::json!({"frame": data.clone(), "beginsTurn": begins_turn}));
        }
        facts.extend(translate_frame(core, deps, thread, frame, &entry)?);
    }
    let facts = deps.repo.mark_yielded_end(core, thread, facts)?;
    Ok(Translation { facts, journal })
}

/// `translateFrame` (`actor.ts:492`): diagnostics, the usage account, then the attachment echo.
fn translate_frame(
    core: &Rc<Core>,
    deps: &ActorDeps,
    thread: &ThreadId,
    frame: &FrameRef,
    entry: &TranslatedFrame,
) -> Result<Vec<Value>, EngineError> {
    if !entry.diagnostics.is_empty() {
        deps.links.diagnostic(core, thread, &entry.diagnostics);
    }
    let usage_account = match frame {
        FrameRef::Native(frame) => frame.usage_account.clone(),
        FrameRef::Js { .. } => None,
    };
    let uses_account = entry
        .facts
        .iter()
        .any(|fact| text(fact, "type") == Some("usage"));
    let account_id = if uses_account {
        match &usage_account {
            Some(account) => Some(account.id.clone()),
            None => deps.repo.session_instance(core, thread)?,
        }
    } else {
        None
    };
    let mut facts = Vec::with_capacity(entry.facts.len());
    for fact in &entry.facts {
        let mut fact = fact.clone();
        if text(&fact, "type") == Some("usage")
            && let Some(account_id) = &account_id
            && let Value::Object(map) = &mut fact
        {
            map.insert("accountId", Value::String(account_id.as_str().into()));
            if map.get("billingMode").is_none()
                && let Some(account) = &usage_account
            {
                let mode = match account.billing_mode {
                    ace_adapter_api::BillingMode::Api => "api",
                    ace_adapter_api::BillingMode::Subscription => "subscription",
                    ace_adapter_api::BillingMode::Unknown => "unknown",
                };
                map.insert("billingMode", Value::String(mode.into()));
            }
        }
        let echoed = crate::frames::attachment_echo(fact, &mut |hash| {
            deps.repo.attachment(core, thread, hash)
        })?;
        facts.push(echoed);
    }
    Ok(facts)
}

/// `syncQueue` (`actor.ts:517`).
pub fn sync_queue(core: &Rc<Core>, thread: &ThreadId) -> Result<(), EngineError> {
    let deps = core.actor_deps.borrow().clone();
    let Some(fact) = deps.repo.engine_queue_fact(core, thread)? else {
        return Ok(());
    };
    apply(core, thread, &[fact])
}

/// `apply` (`actor.ts:521`).
pub fn apply(core: &Rc<Core>, thread: &ThreadId, facts: &[Value]) -> Result<(), EngineError> {
    let deps = core.actor_deps.borrow().clone();
    let now = core.ports.now();
    let generation = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .map(|actor| actor.generation)
        })?
        .unwrap_or(0);
    deps.repo.apply(core, thread, facts, now, generation)?;
    if facts.iter().any(is_process_exit) {
        deps.repo.clear_incomplete_blobs(core, thread);
        leases::release_inputs(core, thread);
    }
    timer::schedule(core, thread);
    // The actor's own bookkeeping is re-read after each call that can re-enter.
    core.with_state(|state| {
        let limits = state.limits;
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            flow::update_pressure(actor, &limits);
        }
    })
    .ok();
    Ok(())
}
