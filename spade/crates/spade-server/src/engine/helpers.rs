//! Helpers (ADR 0152, docs/helpers.md): a bot's `helper` call runs as one of its background
//! jobs. The job's work is a hidden conversation of the helper's own, driven by the same turn
//! worker as any reply, so it streams, retries, compacts, pauses and resumes after a restart.
//!
//! - The job waits for the helper's conversation to end, then delivers its result once.
//! - At most `Limits::helpers_at_once` helpers of a bot have a reply open; the rest wait queued
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
use spade_core::routing;
use spade_core::tools::Registry;
use spade_core::{Event, Transcript};
use spade_store::{StoreError, StoredHelper};

use super::{AnswerError, Engine};
use crate::tools::ToolOutput;

/// Where helper profiles come from besides the built-in `explore` and `general`: the person's
/// plugin agents (ADR 0151) fill one. A profile named like a built-in one never replaces it.
pub trait ProfileSource: Send + Sync {
    /// The profiles the bot `agent` may give its helpers.
    fn profiles(&self, agent: &str) -> Vec<Profile>;
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
    /// A role name or `endpoint/model` the person configured (ADR 0162).
    #[serde(default)]
    model: Option<String>,
    /// Rerun once on the bot's own model if it fails; `None` follows the bot's setting.
    #[serde(default)]
    escalate: Option<bool>,
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

    /// Every profile a helper of the bot conversation `bot` can have: the built-in ones, then
    /// the source's for its bot.
    pub(crate) fn helper_profiles(&self, bot: &str) -> Vec<Profile> {
        let mut profiles = vec![Profile::explore(), Profile::general()];
        if let (Some(source), Some(agent)) = (self.helpers.source.get(), self.agent_of(bot)) {
            for profile in source.profiles(&agent) {
                if !profiles.iter().any(|p| p.name == profile.name) {
                    profiles.push(profile);
                }
            }
        }
        profiles
    }

    /// Whether conversation `id` is a helper's (its terminal commands run in a session of their
    /// own, ADR 0158).
    pub(crate) fn is_helper(&self, id: &str) -> bool {
        self.helper_of(id).is_some()
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
        // A worker's tools are never more than its parent's (ADR 0161).
        let registry = self.narrow_registry(id, self.tools.registry_for(id));
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
        let arguments: Arguments = match crate::tools::parse(arguments) {
            Ok(arguments) => arguments,
            Err(refused) => return refused,
        };
        let helper = match self.helper_or_start(bot, job, &arguments, None) {
            Ok(helper) => helper,
            Err(refused) => return refused,
        };
        self.fill_slots(&helper.parent);
        let output = self.helper_result(&helper).await;
        // Escalation (ADR 0162): failed work on another model reruns once on the bot's own.
        let own = self.reply_model(bot);
        let on = arguments.escalate.unwrap_or_else(|| self.escalates(bot));
        let outcome = self.helper_outcome(&helper);
        let Some(own) = routing::escalate_to(on, 0, outcome, &helper.model, &own) else {
            return output;
        };
        let retry = match self.helper_or_start(
            bot,
            &routing::retry_job(job),
            &arguments,
            Some(own.to_owned()),
        ) {
            Ok(retry) => retry,
            Err(_) => return output,
        };
        self.fill_slots(&retry.parent);
        let mut second = self.helper_result(&retry).await;
        second.content = format!(
            "(The helper failed on {}, so it ran again on {}.)\n\n{}",
            helper.model, retry.model, second.content
        );
        second
    }

    /// The helper stored for `job`, else a new one.
    fn helper_or_start(
        self: &Arc<Self>,
        bot: &str,
        job: &str,
        arguments: &Arguments,
        model: Option<String>,
    ) -> Result<StoredHelper, ToolOutput> {
        match self.store.helper_for_job(bot, job) {
            Ok(Some(helper)) => Ok(helper),
            Ok(None) => self.start_helper(bot, job, arguments, model),
            Err(error) => Err(ToolOutput::error(format!(
                "Spade could not start it: {error}"
            ))),
        }
    }

    /// How a helper that ended went, for escalation: failed when its reply failed or it finished
    /// without an answer; stopped when anyone stopped it or its job.
    fn helper_outcome(&self, helper: &StoredHelper) -> routing::Outcome {
        let parent = self.load(&helper.parent).unwrap_or_default();
        if spade_core::turn::job_stopped(&parent, routing::base_job(&helper.job)) {
            return routing::Outcome::Stopped;
        }
        let events = self.load(&helper.conversation).unwrap_or_default();
        let end = events.iter().find_map(|event| match event {
            Event::Known(
                known @ (Known::ReplyFinished { .. }
                | Known::ReplyStopped { .. }
                | Known::ReplyFailed { .. }
                | Known::ReplyInterrupted { .. }),
            ) => Some(known),
            _ => None,
        });
        match end {
            Some(Known::ReplyFailed { .. }) => routing::Outcome::Failed,
            Some(Known::ReplyFinished { text, .. }) if text.trim().is_empty() => {
                routing::Outcome::Failed
            }
            Some(Known::ReplyFinished { .. }) => routing::Outcome::Done,
            _ => routing::Outcome::Stopped,
        }
    }

    /// Stores the helper's conversation for `job` (the bot's job, or its rerun), queued: its
    /// task and no reply yet. `model` is a rerun's; otherwise the call's, the profile's or the
    /// `helper` role's.
    fn start_helper(
        self: &Arc<Self>,
        bot: &str,
        job: &str,
        arguments: &Arguments,
        model: Option<String>,
    ) -> Result<StoredHelper, ToolOutput> {
        let task = arguments.task.trim();
        if task.is_empty() {
            return Err(ToolOutput::error("Give the helper a task."));
        }
        if task.chars().count() > TASK_CHARS {
            return Err(ToolOutput::error(format!(
                "The task is longer than {TASK_CHARS} characters; give the helper less."
            )));
        }
        if spade_core::brain::CliModel::is(&self.reply_model(bot)) {
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
        let profiles = self.helper_profiles(bot);
        let Some(profile) = profiles.into_iter().find(|p| p.name == wanted) else {
            let names: Vec<String> = self
                .helper_profiles(bot)
                .into_iter()
                .map(|p| format!("{} ({})", p.name, p.about))
                .collect();
            return Err(ToolOutput::error(format!(
                "There is no helper profile named {wanted}. Profiles: {}.",
                names.join("; ")
            )));
        };
        // The call's model (a role or one the person configured), else the profile's if the
        // person still has it, else the `helper` role's (ADR 0162).
        let wanted = arguments
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty());
        let model = match (model, wanted) {
            (Some(model), _) => model,
            (None, Some(wanted)) => self.pick_model(bot, wanted).map_err(ToolOutput::error)?,
            (None, None) => profile
                .model
                .clone()
                .filter(|m| self.models.resolve(m).is_some())
                .unwrap_or_else(|| self.role_model(bot, routing::Role::Helper)),
        };
        let base = routing::base_job(job);
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
                contract: None,
            });
        }
        let reply = events
            .iter()
            .find_map(|event| match event {
                Event::Known(Known::JobStarted { job: j, reply, .. }) if j == base => {
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
                Ok(events) if spade_core::turn::job_stopped(&events, base) => {
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

    /// What the helper the bot's job `job` runs has spent, its rerun included; `None` when the
    /// job is no helper.
    pub(super) fn helper_cost(&self, bot: &str, job: &str) -> Option<u64> {
        let helper = self.store.helper_for_job(bot, job).ok()??;
        let mut spent = helper::spent(&self.load(&helper.conversation).ok()?);
        if let Ok(Some(retry)) = self.store.helper_for_job(bot, &routing::retry_job(job))
            && let Ok(events) = self.load(&retry.conversation)
        {
            spent += helper::spent(&events);
        }
        Some(spent)
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
            let mut free =
                helper::free_slots(stages.iter().map(|(_, s)| *s), self.limits.helpers_at_once);
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
            let job = routing::base_job(&helper.job).to_owned();
            if Some(helper.reply.as_str()) != reply && !named.contains(&job) {
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
            ask,
            tool_key,
            app,
            acts_in,
            launch,
            stopped,
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
            ask: *ask,
            tool_key: tool_key.clone(),
            app: app.clone(),
            acts_in: acts_in.clone(),
            launch: *launch,
            helper: Some(Box::new(HelperAsk {
                // The bot's job, whose end clears the wait, even for a rerun.
                job: routing::base_job(&helper.job).to_owned(),
                conversation: helper.conversation.clone(),
                call_id: call_id.clone(),
            })),
            stopped: *stopped,
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
        by: Option<&spade_core::org::Member>,
    ) -> Result<(), AnswerError> {
        let entry = by.and_then(|member| self.answer_entry(bot, call_id, allowed, always, member));
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
        let transcript = Transcript::fold(helper_events.iter());
        if !transcript.awaiting.iter().any(|c| c == &ask.call_id) {
            return Err(AnswerError::NotAwaiting);
        }
        let helper_reply = transcript
            .open_reply()
            .and_then(|m| m.reply.clone())
            .unwrap_or_default();
        // "Always" is stored in the bot's conversation, so it holds for the bot and every helper
        // of it from now on.
        self.append_audited(
            bot,
            &[Event::Known(Known::ApprovalAnswered {
                reply: bot_reply,
                call_id: call_id.to_owned(),
                allowed,
                always,
                by: by.cloned().map(Box::new),
            })],
            &entry.into_iter().collect::<Vec<_>>(),
        )?;
        self.append(
            &ask.conversation,
            &Event::Known(Known::ApprovalAnswered {
                reply: helper_reply,
                call_id: ask.call_id.clone(),
                allowed,
                always,
                by: None,
            }),
        )?;
        self.live(&ask.conversation).wake.notify_one();
        Ok(())
    }

    /// After a restart: helpers Stop was pressed on close as stopped; the rest carry on from
    /// their events once Spade opens for work (`fill_slots`), rather than ending "unknown".
    pub(super) fn settle_helpers_after_restart(&self) -> Result<(), StoreError> {
        for helper in self.store.helpers()? {
            // A stop the bot stored that names this helper's job or reply holds, even when the
            // job's end was stored and the helper's own stop was not (a crash between the two):
            // recovery by the bot's open jobs alone never sees such a helper.
            let parent = self.load(&helper.parent)?;
            if spade_core::turn::job_stopped(&parent, routing::base_job(&helper.job)) {
                self.stop_helper_after_restart(&helper)?;
            }
            let events = self.load(&helper.conversation)?;
            let transcript = Transcript::fold(events.iter());
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
        let transcript = Transcript::fold(events.iter());
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
    /// `{job, conversation, profile, model, attempt, task, state, cost_micros}` (`attempt` 2 for
    /// a rerun on the bot's model, ADR 0162), `state` one of `queued`,
    /// `working`, `waiting` (on the person) or `ended`. `None` for an unknown conversation.
    pub fn helpers_view(&self, id: &str) -> Result<Option<Vec<Value>>, StoreError> {
        if !self.reachable(id)? {
            return Ok(None);
        }
        let mut shown = Vec::new();
        for helper in self.store.helpers_of(id)? {
            let events = self.load(&helper.conversation)?;
            let transcript = Transcript::fold(events.iter());
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
                "model": helper.model,
                "attempt": routing::attempt(&helper.job) + 1,
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
