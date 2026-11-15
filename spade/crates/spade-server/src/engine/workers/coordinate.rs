//! Coordinating workers (ADR 0161): `worker_message`, `worker_status`, `worker_result`,
//! `worker_stop` and `worker_budget`, on a bot's worker bots, its ace children and its helpers,
//! and noting the ace children a `delegate` started.

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::Event;
use spade_core::event::{FromAgent, Known};
use spade_core::goal::Evidence;
use spade_core::tree::{self, AceChild, Kind, Started};
use spade_store::StoredHelper;

use super::super::Engine;
use super::budget::PERSON;
use crate::tools::ToolOutput;

/// The most of an evidence call's stored result `worker_result` shows, in characters.
const EVIDENCE_CHARS: usize = 2_000;

/// A worker a bot named.
enum Found {
    Bot { conversation: String },
    Ace(AceChild),
    Helper(StoredHelper),
}

/// The worker a call names (`worker`), and the calling conversation.
#[derive(serde::Deserialize)]
struct Named {
    #[serde(default)]
    worker: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    budget_usd: Option<f64>,
}

impl Engine {
    /// The worker `reference` (an id or a name) of `caller`: a worker bot anywhere under it, one of
    /// its ace children, or one of its helpers (by job).
    fn find_worker(&self, caller: &str, reference: &str) -> Result<Found, String> {
        let reference = reference.trim();
        if reference.is_empty() {
            return Err("Name the worker: its id or name, from worker_status.".to_owned());
        }
        let mut named = Vec::new();
        for conversation in self.worker_subtree(caller).into_iter().skip(1) {
            if let Ok(Some(agent)) = self.store.agent_for_conversation(&conversation)
                && (agent.id == reference || agent.name.eq_ignore_ascii_case(reference))
            {
                if agent.id == reference {
                    return Ok(Found::Bot { conversation });
                }
                named.push(conversation);
            }
        }
        match named.as_slice() {
            [one] => {
                return Ok(Found::Bot {
                    conversation: one.clone(),
                });
            }
            [] => {}
            _ => {
                return Err(format!(
                    "More than one worker is named {reference:?}; use its id."
                ));
            }
        }
        let events = self.load(caller).map_err(|e| e.to_string())?;
        if let Some(child) = tree::ace_children(events.iter())
            .into_iter()
            .find(|c| c.thread == reference || c.name.eq_ignore_ascii_case(reference))
        {
            return Ok(Found::Ace(child));
        }
        if let Ok(Some(helper)) = self.store.helper_for_job(caller, reference) {
            return Ok(Found::Helper(helper));
        }
        Err(format!(
            "You have no worker {reference:?}; worker_status lists them."
        ))
    }

    /// `worker_message`: steers a worker bot (or starts its next turn), or messages an ace child.
    pub(crate) async fn worker_message(
        self: &Arc<Self>,
        key: &str,
        arguments: Value,
    ) -> ToolOutput {
        let Some((caller, call)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        let named: Named = match crate::tools::parse(arguments) {
            Ok(named) => named,
            Err(refused) => return refused,
        };
        let text = named.text.trim();
        if text.is_empty() {
            return ToolOutput::error("The message is empty.");
        }
        if text.chars().count() > self.limits.longest_message {
            return ToolOutput::error("The message is too long.");
        }
        match self.find_worker(caller, &named.worker) {
            Ok(Found::Bot { conversation }) => {
                if self.worker_queued(&conversation) {
                    return ToolOutput::error(
                        "That worker is queued: it starts on its brief when one of your workers \
                         settles. Message it then.",
                    );
                }
                let message = self.message_from(caller, text);
                match self.deliver(&conversation, &message) {
                    Ok(()) => ToolOutput::ok(
                        "Delivered. Its report comes back here when it settles again.",
                    ),
                    Err(error) => ToolOutput::error(format!("Not delivered: {error}")),
                }
            }
            Ok(Found::Ace(child)) => {
                let Some(tool) = self.tools.get_for(caller, "agent_message") else {
                    return ToolOutput::error("ace's agent_message is not available now.");
                };
                let request = format!("spade-{}", super::lifecycle::id_safe(call));
                let arguments =
                    json!({ "threadId": child.thread, "requestId": request, "text": text });
                tool.run(key, arguments).await
            }
            Ok(Found::Helper(_)) => ToolOutput::error(
                "A helper hears only its task; start another helper with what it needs.",
            ),
            Err(why) => ToolOutput::error(why),
        }
    }

    /// A message from the bot of `caller` as its worker reads it: Spade's words saying who sent
    /// it, and another bot's message (untrusted) when the sender had untrusted content in view.
    fn message_from(&self, caller: &str, text: &str) -> Event {
        let events = self.load(caller).unwrap_or_default();
        let registry = self.registry_for(caller);
        let tainted = !spade_core::context::untrusted_in_view(&events, &registry).is_empty();
        let me = self.store.agent_for_conversation(caller).ok().flatten();
        let mut message = Event::user_message(text);
        if let (
            Event::Known(Known::UserMessage {
                context,
                from_agent,
                ..
            }),
            Some(me),
        ) = (&mut message, me)
        {
            *context = Some(format!(
                "From the bot {} (id {}), whose worker you are.",
                me.name, me.id
            ));
            if tainted {
                *from_agent = Some(FromAgent {
                    id: me.id,
                    name: me.name,
                    depth: 1,
                    machine: None,
                });
            }
        }
        message
    }

    /// `worker_status`: the subtree of `caller`, or of one worker.
    pub(crate) fn worker_status(&self, key: &str, arguments: Value) -> ToolOutput {
        let Some((caller, _)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        let worker = arguments
            .get("worker")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|w| !w.is_empty());
        let shown = match worker {
            Some(worker) => match self.worker_node(caller, worker) {
                Some(node) => node,
                None => {
                    return ToolOutput::error(format!(
                        "You have no worker {worker:?}; worker_status without one lists them."
                    ));
                }
            },
            None => match self.bot_node(caller, 0) {
                Ok(node) => node,
                Err(error) => return ToolOutput::error(error.to_string()),
            },
        };
        ToolOutput::ok(shown.to_string())
    }

    /// `worker_result`: what a worker achieved by the evidence, never by its own word.
    pub(crate) fn worker_result(&self, key: &str, arguments: Value) -> ToolOutput {
        let Some((caller, _)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        let named: Named = match crate::tools::parse(arguments) {
            Ok(named) => named,
            Err(refused) => return refused,
        };
        match self.find_worker(caller, &named.worker) {
            Ok(Found::Bot { conversation }) => {
                let events = match self.load(&conversation) {
                    Ok(events) => events,
                    Err(error) => return ToolOutput::error(error.to_string()),
                };
                ToolOutput::ok(verified_outcome(&events).to_string()).untrusted()
            }
            Ok(Found::Ace(child)) => ToolOutput::ok(
                json!({
                    "kind": "ace",
                    "state": child.state.name(),
                    "result": "Read an ace child's result from its delegate or wait result, or \
                               with ace's agents_status.",
                })
                .to_string(),
            ),
            Ok(Found::Helper(helper)) => {
                let events = self.load(caller).unwrap_or_default();
                let result = events.iter().find_map(|e| match e {
                    Event::Known(Known::JobFinished { job, content, .. }) if *job == helper.job => {
                        Some(content.clone())
                    }
                    _ => None,
                });
                ToolOutput::ok(
                    json!({
                        "kind": "helper",
                        "verified": false,
                        "result": result,
                        "note": "A helper has no goal to check: this is its own answer.",
                    })
                    .to_string(),
                )
                .untrusted()
            }
            Err(why) => ToolOutput::error(why),
        }
    }

    /// `worker_stop`: stops one worker and everything under it.
    pub(crate) fn worker_stop(self: &Arc<Self>, key: &str, arguments: Value) -> ToolOutput {
        let Some((caller, _)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        let named: Named = match crate::tools::parse(arguments) {
            Ok(named) => named,
            Err(refused) => return refused,
        };
        match self.find_worker(caller, &named.worker) {
            Ok(Found::Bot { conversation }) => {
                let queued = self.worker_queued(&conversation);
                if queued {
                    let marker = Event::Known(Known::StopRequested {
                        reply: None,
                        jobs: Vec::new(),
                    });
                    if let Err(error) = self.record(&conversation, &marker) {
                        return ToolOutput::error(format!("Not stopped: {error}"));
                    }
                    return ToolOutput::ok("Stopped before it began.");
                }
                match self.stop(&conversation) {
                    Ok(_) => ToolOutput::ok("Stopped, with everything under it."),
                    Err(error) => ToolOutput::error(format!("Not stopped: {error}")),
                }
            }
            Ok(Found::Ace(child)) => {
                self.cancel_ace_child(caller, &child.thread, &child.name);
                ToolOutput::ok(
                    "ace was asked to cancel it and what it started. Confirm with ace's \
                     agents_status if it matters.",
                )
            }
            Ok(Found::Helper(helper)) => {
                self.stop_helpers(caller, None, std::slice::from_ref(&helper.job));
                ToolOutput::ok("Stopped.")
            }
            Err(why) => ToolOutput::error(why),
        }
    }

    /// `worker_budget`: sets a worker bot's subtree budget.
    pub(crate) fn worker_budget(self: &Arc<Self>, key: &str, arguments: Value) -> ToolOutput {
        let Some((caller, _)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        let named: Named = match crate::tools::parse(arguments) {
            Ok(named) => named,
            Err(refused) => return refused,
        };
        let micros = match named.budget_usd {
            Some(usd) if usd.is_finite() && usd > 0.0 => spade_core::spending::usd_to_micros(usd),
            _ => return ToolOutput::error("budget_usd is a positive amount of dollars."),
        };
        let Ok(Found::Bot { conversation }) = self.find_worker(caller, &named.worker) else {
            return ToolOutput::error(
                "Only a worker bot under you has a budget; worker_status lists them.",
            );
        };
        let by = self.agent_name(caller);
        match self.set_budget(&conversation, Some(micros), &by) {
            Ok(()) => ToolOutput::ok(format!(
                "Its budget is {}; it has spent {} so far, with everything under it.",
                spade_core::oversight::dollars(micros),
                spade_core::oversight::dollars(self.subtree_spent(&conversation)),
            )),
            Err(error) => ToolOutput::error(error.to_string()),
        }
    }

    /// The person sets (or with `None` takes away) agent `agent`'s budget as a worker. `None`
    /// for no such agent; `Some(false)` when it is no worker.
    pub fn set_agent_budget(
        self: &Arc<Self>,
        agent: &str,
        budget_micros: Option<u64>,
    ) -> Result<Option<bool>, spade_store::StoreError> {
        let Some(found) = self.store.agent(agent)? else {
            return Ok(None);
        };
        if self.worker_link(&found.conversation).is_none() {
            return Ok(Some(false));
        }
        self.set_budget(&found.conversation, budget_micros, PERSON)?;
        Ok(Some(true))
    }

    /// ace answered `delegate` call `key` with `answer` (its first answer, before any wait):
    /// each thread it started is noted as an ace child of the calling bot, once.
    pub(crate) fn ace_delegated(&self, key: &str, arguments: &Value, answer: &str) {
        let Some((caller, call)) = key.split_once('.') else {
            return;
        };
        let threads = tree::delegated_threads(answer);
        if threads.is_empty() {
            return;
        }
        let roles: Vec<String> = arguments
            .get("tasks")
            .and_then(Value::as_array)
            .map(|tasks| {
                tasks
                    .iter()
                    .map(|t| {
                        t.get("role")
                            .and_then(Value::as_str)
                            .unwrap_or("ace agent")
                            .chars()
                            .take(80)
                            .collect()
                    })
                    .collect()
            })
            .unwrap_or_default();
        let _order = super::lock(&self.record_lock);
        let Ok(events) = self.load(caller) else {
            return;
        };
        let known = tree::ace_children(events.iter());
        let started: Vec<Event> = threads
            .iter()
            .enumerate()
            .filter(|(_, thread)| !known.iter().any(|c| &c.thread == *thread))
            .map(|(index, thread)| {
                Event::Known(Known::WorkerStarted(Started {
                    worker: thread.clone(),
                    kind: Kind::Ace,
                    name: roles
                        .get(index)
                        .cloned()
                        .unwrap_or_else(|| "ace agent".to_owned()),
                    conversation: None,
                    call: call.to_owned(),
                    budget_micros: None,
                }))
            })
            .collect();
        if !started.is_empty()
            && let Err(error) = self.append_events(caller, &started)
        {
            tracing::error!(%error, "could not note the ace children a delegate started");
        }
    }
}

/// A worker's outcome by its evidence (ADR 0159): its goal and criteria, each plan item with
/// the stored results that back it, and the latest verdict. Never its own words as the outcome.
fn verified_outcome(events: &[Event]) -> Value {
    let Some(task) = spade_core::goal::view::task(events) else {
        return json!({
            "verified": false,
            "note": "It has no goal, so nothing of what it did is checked. Its last words are \
                     its own, not evidence.",
            "last_words": tree::last_words(events),
        });
    };
    let items: Vec<Value> = task
        .items
        .iter()
        .map(|item| {
            let evidence: Vec<Value> = item
                .evidence
                .iter()
                .map(|e| match e {
                    Evidence::Output { call } => json!({
                        "kind": "output",
                        "call": call,
                        "result": stored_result(events, call),
                    }),
                    other => serde_json::to_value(other).unwrap_or_default(),
                })
                .collect();
            json!({
                "id": item.id,
                "text": item.text,
                "status": item.status,
                "verified": item.verified,
                "evidence": evidence,
            })
        })
        .collect();
    json!({
        "verified": task.progress.state == spade_core::goal::view::State::Done,
        "progress": task.progress,
        "goal": { "title": task.goal.title, "text": task.goal.text, "criteria": task.goal.criteria },
        "items": items,
        "verdict": task.verdict,
    })
}

/// The stored result of call or job `call`, cut.
fn stored_result(events: &[Event], call: &str) -> Option<String> {
    events.iter().rev().find_map(|e| match e {
        Event::Known(Known::ToolFinished {
            call_id, content, ..
        }) if call_id == call => Some(cut(content)),
        Event::Known(Known::JobFinished { job, content, .. }) if job == call => Some(cut(content)),
        _ => None,
    })
}

fn cut(text: &str) -> String {
    if text.chars().count() <= EVIDENCE_CHARS {
        return text.to_owned();
    }
    let kept: String = text.chars().take(EVIDENCE_CHARS).collect();
    format!("{kept}…")
}
