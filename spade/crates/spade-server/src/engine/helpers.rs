//! Helpers (ADR 0152, docs/helpers.md): a bot's `helper` call runs as one of its background
//! jobs. The job's work is a hidden conversation of the helper's own, driven by the same turn
//! worker as any reply, so it streams, retries, compacts, pauses and resumes after a restart.
//!
//! - The job waits for the helper's conversation to end, then delivers its result once.
//! - At most [`helper::MOST_RUNNING`] helpers of a bot have a reply open; the rest wait queued
//!   (a task message and no reply) and start oldest first as slots free.
//! - A call a helper's gate would ask about is asked in the bot's conversation too, naming the
//!   helper; the person's answer there reaches the helper.
//! - Stop on the bot's reply stops the helpers it started.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use spade_core::context;
use spade_core::event::{FromAgent, HelperAsk, Known};
use spade_core::helper::{self, Profile, Stage};
use spade_core::tools::Registry;
use spade_core::{Event, Transcript};
use spade_store::{StoreError, StoredHelper};

use super::{AnswerError, Engine};
use crate::tools::ToolOutput;

/// Where helper profiles come from besides the built-in `explore` and `general`: the person's
/// plugin agents (ADR 0151) fill one. A profile named like a built-in one never replaces it.
pub trait ProfileSource: Send + Sync {
    fn profiles(&self) -> Vec<Profile>;
}

/// The longest task a helper is given, in characters.
pub const TASK_CHARS: usize = 20_000;

/// How often a job waiting on its helper looks again without being woken, so a missed wake
/// costs a few seconds and never a lost result.
const LOOK_AGAIN: Duration = Duration::from_secs(5);

/// The `helper` call's arguments.
#[derive(serde::Deserialize)]
struct Arguments {
    task: String,
    #[serde(default)]
    profile: Option<String>,
}

/// Helpers' state the engine keeps in memory.
#[derive(Default)]
pub(super) struct Shared {
    /// Plugin agents' profiles, once the server has set a source.
    source: std::sync::OnceLock<Arc<dyn ProfileSource>>,
    /// Each conversation's helper row, or `None` for a conversation that is no helper. A
    /// helper's row is written with its conversation, so a known answer never changes.
    known: std::sync::Mutex<HashMap<String, Option<StoredHelper>>>,
    /// Woken whenever a helper ends or is stopped, for the jobs waiting on them.
    changed: tokio::sync::Notify,
}

impl Engine {
    /// Sets where profiles beyond the built-in ones come from. Once; later calls are ignored.
    pub fn set_profile_source(&self, source: Arc<dyn ProfileSource>) {
        let _ = self.helpers.source.set(source);
    }

    /// Every profile a helper can have: the built-in ones, then the source's.
    pub(crate) fn helper_profiles(&self) -> Vec<Profile> {
        let mut profiles = vec![Profile::explore(), Profile::general()];
        if let Some(source) = self.helpers.source.get() {
            for profile in source.profiles() {
                if !profiles.iter().any(|p| p.name == profile.name) {
                    profiles.push(profile);
                }
            }
        }
        profiles
    }

    /// The helper whose conversation is `id`, if it is one.
    pub(super) fn helper_of(&self, id: &str) -> Option<StoredHelper> {
        if let Some(known) = self
            .helpers
            .known
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
        {
            return known.clone();
        }
        // A failed read is not remembered, so the next look tries again.
        let found = self.store.helper(id).ok()?;
        self.helpers
            .known
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.to_owned(), found.clone());
        found
    }

    /// The tools `id` may use: a helper's are its bot's, narrowed by its profile.
    pub(super) fn registry_for(&self, id: &str) -> Registry {
        let registry = self.tools.registry_for(id);
        match self.helper_of(id) {
            Some(helper) => profile_of(&helper).registry(registry),
            None => registry,
        }
    }

    /// The tools the model is offered in `id`: the same list for every bot, and a helper's
    /// narrower one.
    pub(super) fn offered_for(&self, id: &str) -> Vec<spade_models::ToolSpec> {
        match self.helper_of(id) {
            Some(helper) => profile_of(&helper)
                .registry(self.tools.registry())
                .offered(),
            None => self.tools.registry().offered(),
        }
    }

    /// The standing instructions for `id`: Spade's, or a helper's own.
    pub(super) fn system_for(&self, id: &str) -> String {
        match self.helper_of(id) {
            Some(helper) => helper.system,
            None => context::SYSTEM.to_owned(),
        }
    }

    /// The `helper` tool's work, run as the bot's job with `key` (`<bot conversation>.<job>`):
    /// starts the helper (once, even when a restart runs this again), waits for it to end and
    /// answers with its result.
    pub(crate) async fn run_helper(self: &Arc<Self>, key: &str, arguments: Value) -> ToolOutput {
        let Some((bot, job)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        let helper = match self.store.helper_for_job(bot, job) {
            Ok(Some(helper)) => helper,
            Ok(None) => match self.start_helper(bot, job, arguments) {
                Ok(helper) => helper,
                Err(refused) => return refused,
            },
            Err(error) => return ToolOutput::error(format!("Spade could not start it: {error}")),
        };
        self.fill_slots(&helper.parent);
        self.helper_result(&helper).await
    }

    /// Stores the helper's conversation, queued: its task and no reply yet.
    fn start_helper(
        self: &Arc<Self>,
        bot: &str,
        job: &str,
        arguments: Value,
    ) -> Result<StoredHelper, ToolOutput> {
        let arguments: Arguments = crate::tools::parse(arguments)?;
        let task = arguments.task.trim();
        if task.is_empty() {
            return Err(ToolOutput::error("Give the helper a task."));
        }
        if task.chars().count() > TASK_CHARS {
            return Err(ToolOutput::error(format!(
                "The task is longer than {TASK_CHARS} characters; give the helper less."
            )));
        }
        let model = self.reply_model(bot);
        if spade_core::brain::CliModel::is(&model) {
            return Err(ToolOutput::error(
                "Bots that think through a subscription have no helpers; that CLI splits work \
                 its own way.",
            ));
        }
        let wanted = arguments
            .profile
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .unwrap_or(helper::DEFAULT_PROFILE);
        let profiles = self.helper_profiles();
        let Some(profile) = profiles.into_iter().find(|p| p.name == wanted) else {
            let names: Vec<String> = self
                .helper_profiles()
                .into_iter()
                .map(|p| format!("{} ({})", p.name, p.about))
                .collect();
            return Err(ToolOutput::error(format!(
                "There is no helper profile named {wanted}. Profiles: {}.",
                names.join("; ")
            )));
        };
        // A model the profile names, if the person still has it; else the bot's.
        let model = profile
            .model
            .clone()
            .filter(|m| self.models.resolve(m).is_some())
            .unwrap_or(model);
        // A task written while the bot had untrusted content in view may carry planted words:
        // it reaches the helper as the bot's message, which taints the helper's turn.
        let events = self.load(bot).unwrap_or_default();
        let tainted = !context::untrusted_in_view(&events, &self.registry_for(bot)).is_empty();
        let mut message = Event::user_message(task);
        if tainted
            && let Event::Known(Known::UserMessage { from_agent, .. }) = &mut message
            && let Ok(Some(agent)) = self.store.agent_for_conversation(bot)
        {
            *from_agent = Some(FromAgent {
                id: agent.id,
                name: agent.name,
                depth: 0,
                machine: None,
            });
        }
        let reply = events
            .iter()
            .find_map(|event| match event {
                Event::Known(Known::JobStarted { job: j, reply, .. }) if j == job => {
                    Some(reply.clone())
                }
                _ => None,
            })
            .unwrap_or_default();
        let stored = StoredHelper {
            conversation: self.ids.next("h"),
            parent: bot.to_owned(),
            job: job.to_owned(),
            reply,
            profile: profile.name.clone(),
            system: profile.system(),
            reads_only: profile.reads_only,
            tools: profile.tools.clone(),
            model,
            created_ms: self.now_ms(),
        };
        self.helper_starting(bot);
        let created = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.deleting(bot) {
                return Err(ToolOutput::error(context::NOT_RUN));
            }
            // Stop stores its marker under this lock, then stops the helpers it finds: a helper
            // is either made before the marker, and found, or sees it here and is never made.
            match self.load(bot) {
                Ok(events) if spade_core::turn::job_stopped(&events, job) => {
                    return Err(ToolOutput::error(context::JOB_STOPPED));
                }
                Ok(_) => {}
                Err(error) => {
                    return Err(ToolOutput::error(format!(
                        "Spade could not start it: {error}"
                    )));
                }
            }
            self.store
                .create_helper(&stored, std::slice::from_ref(&message), self.now_ms())
        };
        match created {
            Ok(true) => Ok(stored),
            // Made meanwhile by another run of this job: that one is the helper.
            Ok(false) => match self.store.helper_for_job(bot, job) {
                Ok(Some(helper)) => Ok(helper),
                _ => Err(ToolOutput::error("Spade could not start it.")),
            },
            Err(error) => Err(ToolOutput::error(format!(
                "Spade could not start it: {error}"
            ))),
        }
    }

    /// Waits for the helper to end and answers with what it hands back.
    async fn helper_result(&self, helper: &StoredHelper) -> ToolOutput {
        loop {
            // Listening before looking, so an end between the two is not missed.
            let changed = self.helpers.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match self.load(&helper.conversation) {
                Ok(events) => {
                    if let Some(end) = helper::ended(&events) {
                        let registry = self.registry_for(&helper.conversation);
                        let untrusted = !context::untrusted_in_view(&events, &registry).is_empty();
                        let mut output = if end.is_error {
                            ToolOutput::error(end.content)
                        } else {
                            ToolOutput::ok(end.content)
                        };
                        output.uncertain = end.uncertain;
                        output.untrusted = untrusted;
                        return output;
                    }
                }
                Err(StoreError::NoConversation(_)) => {
                    return ToolOutput::error(context::NOT_RUN);
                }
                Err(_) => {}
            }
            let _ = tokio::time::timeout(LOOK_AGAIN, changed).await;
        }
    }

    /// What the helper the bot's job `job` runs has spent; `None` when the job is no helper.
    pub(super) fn helper_cost(&self, bot: &str, job: &str) -> Option<u64> {
        let helper = self.store.helper_for_job(bot, job).ok()??;
        let events = self.load(&helper.conversation).ok()?;
        Some(helper::spent(&events))
    }

    /// Starts the bot's queued helpers while slots are free, and a worker for each running
    /// helper that has none (after a restart or a pause). Nothing starts while Spade is closing.
    pub(super) fn fill_slots(self: &Arc<Self>, bot: &str) {
        let helpers = match self.store.helpers_of(bot) {
            Ok(helpers) => helpers,
            Err(error) => {
                tracing::error!(%error, "could not list a bot's helpers");
                return;
            }
        };
        let mut drive = Vec::new();
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if !self.admission.load(std::sync::atomic::Ordering::SeqCst) || self.deleting(bot) {
                return;
            }
            let stages: Vec<(StoredHelper, Stage)> = helpers
                .into_iter()
                .map(|h| {
                    let stage = self
                        .load(&h.conversation)
                        .map_or(Stage::Ended, |events| helper::stage(&events));
                    (h, stage)
                })
                .collect();
            let mut free = helper::free_slots(stages.iter().map(|(_, s)| *s));
            for (helper, stage) in stages {
                match stage {
                    Stage::Running => drive.push(helper.conversation),
                    Stage::Queued if free > 0 => {
                        let started = Event::reply_started(self.ids.next("r"), &helper.model);
                        match self.append(&helper.conversation, &started) {
                            Ok(_) => {
                                free -= 1;
                                drive.push(helper.conversation);
                            }
                            Err(error) => tracing::error!(%error, "could not start a helper"),
                        }
                    }
                    Stage::Queued | Stage::Ended => {}
                }
            }
        }
        for conversation in drive {
            self.spawn_turn(&conversation);
        }
    }

    /// After a helper's reply closed: its job hears of it, and a queued helper takes its slot.
    pub(super) fn helper_ended(self: &Arc<Self>, id: &str) {
        let Some(helper) = self.helper_of(id) else {
            return;
        };
        self.helpers.changed.notify_waiters();
        self.fill_slots(&helper.parent);
    }

    /// Stops the bot's helpers a stop names: those of `reply`, and those of the jobs in `named`.
    /// A running one is stopped like any reply; a queued one is marked so it never starts.
    pub(super) fn stop_helpers(self: &Arc<Self>, bot: &str, reply: Option<&str>, named: &[String]) {
        let Ok(helpers) = self.store.helpers_of(bot) else {
            return;
        };
        for helper in helpers {
            if Some(helper.reply.as_str()) != reply && !named.contains(&helper.job) {
                continue;
            }
            let id = helper.conversation.as_str();
            let queued = {
                let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
                match self.load(id) {
                    Ok(events) if helper::stage(&events) == Stage::Queued => {
                        let marker = Event::Known(Known::StopRequested {
                            reply: None,
                            jobs: Vec::new(),
                        });
                        if let Err(error) = self.append(id, &marker) {
                            tracing::error!(%error, "could not stop a queued helper");
                        }
                        true
                    }
                    _ => false,
                }
            };
            if !queued && let Err(error) = self.stop(id) {
                tracing::error!(%error, "could not store a helper's stop");
            }
        }
        self.helpers.changed.notify_waiters();
    }

    /// The helpers' conversations of a bot being deleted, so nothing is delivered to them.
    pub(super) fn helper_conversations(&self, bot: &str) -> Vec<String> {
        self.store
            .helpers_of(bot)
            .map(|helpers| helpers.into_iter().map(|h| h.conversation).collect())
            .unwrap_or_default()
    }

    /// Asks the person about a helper's call: stored in the helper's conversation (where its
    /// turn waits on it) and in its bot's, where the person sees and answers it. `Ok(false)` if
    /// the helper was stopped first.
    pub(super) fn ask_for_helper(
        &self,
        helper: &StoredHelper,
        reply: &str,
        asked: &Event,
    ) -> Result<bool, StoreError> {
        let Event::Known(Known::ApprovalRequested {
            call_id,
            name,
            arguments,
            scope,
            reviewer_reason,
            ..
        }) = asked
        else {
            return Ok(false);
        };
        let mirror = Event::Known(Known::ApprovalRequested {
            reply: helper.reply.clone(),
            call_id: mirrored_id(&helper.job, call_id),
            name: name.clone(),
            arguments: arguments.clone(),
            scope: scope.clone(),
            reviewer_reason: reviewer_reason.clone(),
            helper: Some(HelperAsk {
                job: helper.job.clone(),
                conversation: helper.conversation.clone(),
                call_id: call_id.clone(),
            }),
        });
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(&helper.conversation)?;
            if spade_core::turn::stop_requested(&events, reply) {
                return Ok(false);
            }
            self.append(&helper.conversation, asked)?;
            self.append(&helper.parent, &mirror)?;
        }
        self.announce(&helper.parent);
        Ok(true)
    }

    /// Answers an approval a helper of `bot` waits on, asked in the bot's conversation as
    /// `call_id`. The caller holds `record_lock` and passes the bot's transcript.
    pub(super) fn answer_for_helper(
        &self,
        bot: &str,
        events: &[Event],
        call_id: &str,
        allowed: bool,
        always: bool,
    ) -> Result<(), AnswerError> {
        let asked = events.iter().rev().find_map(|event| match event {
            Event::Known(Known::ApprovalRequested {
                call_id: c,
                reply,
                helper: Some(helper),
                ..
            }) if c == call_id => Some((reply.clone(), helper.clone())),
            _ => None,
        });
        let Some((bot_reply, ask)) = asked else {
            return Err(AnswerError::NotAwaiting);
        };
        let helper_events = self.load(&ask.conversation)?;
        let transcript = Transcript::fold(&helper_events);
        if !transcript.awaiting.iter().any(|c| c == &ask.call_id) {
            return Err(AnswerError::NotAwaiting);
        }
        let helper_reply = transcript
            .open_reply()
            .and_then(|m| m.reply.clone())
            .unwrap_or_default();
        // "Always" is stored in the bot's conversation, so it holds for the bot and every helper
        // of it from now on.
        self.append(
            bot,
            &Event::Known(Known::ApprovalAnswered {
                reply: bot_reply,
                call_id: call_id.to_owned(),
                allowed,
                always,
            }),
        )?;
        self.append(
            &ask.conversation,
            &Event::Known(Known::ApprovalAnswered {
                reply: helper_reply,
                call_id: ask.call_id.clone(),
                allowed,
                always,
            }),
        )?;
        self.live(&ask.conversation).wake.notify_one();
        Ok(())
    }

    /// After a restart: helpers Stop was pressed on close as stopped; the rest carry on from
    /// their events once Spade opens for work (`fill_slots`), rather than ending "unknown".
    pub(super) fn settle_helpers_after_restart(&self) -> Result<(), StoreError> {
        for helper in self.store.helpers()? {
            let events = self.load(&helper.conversation)?;
            let transcript = Transcript::fold(&events);
            if transcript.stopping
                && let Some(close) = transcript.close_after_restart()
            {
                self.record(&helper.conversation, &close)?;
            }
        }
        Ok(())
    }

    /// After a restart, for a helper whose bot's Stop was stored but not carried out: stores
    /// the stop in the helper's conversation, so it never starts (queued) or closes as stopped
    /// (running, by [`Engine::settle_helpers_after_restart`]).
    pub(super) fn stop_helper_after_restart(
        &self,
        helper: &StoredHelper,
    ) -> Result<(), StoreError> {
        let events = self.load(&helper.conversation)?;
        if helper::stage(&events) == Stage::Ended {
            return Ok(());
        }
        let transcript = Transcript::fold(&events);
        let marker = Event::Known(Known::StopRequested {
            reply: transcript.open_reply().and_then(|m| m.reply.clone()),
            jobs: Vec::new(),
        });
        self.record(&helper.conversation, &marker)?;
        Ok(())
    }

    /// Every bot that has helpers, for resuming them.
    pub(super) fn bots_with_helpers(&self) -> Vec<String> {
        let mut bots: Vec<String> = self
            .store
            .helpers()
            .map(|helpers| helpers.into_iter().map(|h| h.parent).collect())
            .unwrap_or_default();
        bots.dedup();
        bots.sort();
        bots.dedup();
        bots
    }
}

impl Engine {
    /// The helpers conversation `id` started, oldest first, as the API shows them:
    /// `{job, conversation, profile, task, state, cost_micros}`, `state` one of `queued`,
    /// `working`, `waiting` (on the person) or `ended`. `None` for an unknown conversation.
    pub fn helpers_view(&self, id: &str) -> Result<Option<Vec<Value>>, StoreError> {
        if self.store.conversation(id)?.is_none() {
            return Ok(None);
        }
        let mut shown = Vec::new();
        for helper in self.store.helpers_of(id)? {
            let events = self.load(&helper.conversation)?;
            let transcript = Transcript::fold(&events);
            let state = match helper::stage(&events) {
                Stage::Queued => "queued",
                Stage::Ended => "ended",
                Stage::Running if !transcript.awaiting.is_empty() => "waiting",
                Stage::Running => "working",
            };
            let task = events.iter().find_map(|event| match event {
                Event::Known(Known::UserMessage { text, .. }) => Some(text.clone()),
                _ => None,
            });
            shown.push(serde_json::json!({
                "job": helper.job,
                "conversation": helper.conversation,
                "profile": helper.profile,
                "task": task,
                "state": state,
                "cost_micros": helper::spent(&events),
            }));
        }
        Ok(Some(shown))
    }
}

/// The id a helper's call is asked under in the bot's conversation: unique there, since each
/// job has one helper and each helper's call ids are unique in its own conversation.
fn mirrored_id(job: &str, call_id: &str) -> String {
    format!("{job}.{call_id}")
}

/// The profile a stored helper runs with, as it was stored.
fn profile_of(helper: &StoredHelper) -> Profile {
    Profile {
        name: helper.profile.clone(),
        about: String::new(),
        instructions: String::new(),
        reads_only: helper.reads_only,
        tools: helper.tools.clone(),
        model: None,
    }
}
