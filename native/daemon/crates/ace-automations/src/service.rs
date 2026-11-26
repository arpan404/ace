// SPDX-License-Identifier: Apache-2.0
//! `AutomationService` without I/O (ADR 0225 A1), ported from
//! `packages/automations/src/service.ts`: put with CAS and revision bookkeeping, admission and
//! queueing, the scheduler's tick, start-up recovery, pause/delete cancellation, file watcher
//! readiness, the inbox and every `AutomationRequest` envelope. Executor and timer work leaves
//! through [`Action`]s; tests and the daemon's wiring drive completions back in. The clock,
//! random draw, admission gate and workspace come in through [`Ports`].

use std::collections::{BTreeMap, HashMap, HashSet};

use ace_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::decisions::{
    PAUSED_REFUSAL, PAUSED_RESULT, render_prompt, run_access, with_run_note, with_webhook_note,
};
use crate::error::{AutomationsError, Result};
use crate::recurrence::Occurrence;
use crate::scheduler::{Admission, Clock, CounterIds, IdSource, Random, Scheduler};
use crate::store::{AutomationStore, Claim, Definition, JobMetadata, Trigger};

/// What the host must do, in order, after a service call.
#[derive(Debug, Clone)]
pub enum Action {
    /// Start the run's thread with this input.
    Execute { run_id: String, input: Value },
    /// Follow work a previous boot left behind; `recovery_empty` follows an empty answer.
    Recover { run_id: String, input: Value },
    /// Stop the run's thread; the run settles through its monitor.
    Interrupt { run_id: String, input: Value },
}

/// File watching, owned by the host (`WorkspaceChanges`, `contracts.ts:53`). Subscribe may fail
/// synchronously; readiness arrives later through [`Service::watch_ready`].
pub trait Workspace {
    fn subscribe(&self, workspace: &str, paths: &[String]) -> std::result::Result<(), String>;
    fn unsubscribe(&self, workspace: &str);
}

pub struct Ports<'a> {
    pub clock: &'a dyn Clock,
    pub random: &'a dyn Random,
    pub admission: &'a dyn Admission,
    pub workspace: Option<&'a dyn Workspace>,
    /// Whether discovery for this automation's provider is still running.
    pub model_loading: Option<&'a dyn Fn(&Definition) -> bool>,
}

/// The lifecycle the TypeScript keeps in `lifecycle.ts`: start owns resources until it ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Stopped,
    Starting,
    Live,
    Stopping,
}

struct Lifecycle {
    phase: Phase,
    stop_requested: bool,
}

impl Lifecycle {
    fn new() -> Lifecycle {
        Lifecycle {
            phase: Phase::Stopped,
            stop_requested: false,
        }
    }

    fn live(&self) -> bool {
        !self.stop_requested && matches!(self.phase, Phase::Starting | Phase::Live)
    }

    fn begin_start(&mut self) -> bool {
        if self.phase != Phase::Stopped {
            return false;
        }
        self.phase = Phase::Starting;
        true
    }

    fn end_start(&mut self) -> bool {
        self.phase = Phase::Live;
        self.stop_requested
    }

    fn begin_stop(&mut self) -> bool {
        if self.phase == Phase::Starting {
            self.stop_requested = true;
            return false;
        }
        if self.phase == Phase::Stopping {
            return false;
        }
        self.phase = Phase::Stopping;
        true
    }

    fn end_stop(&mut self) {
        self.phase = Phase::Stopped;
        self.stop_requested = false;
    }
}

struct Watch {
    workspace: String,
    revision: u64,
}

pub struct Service<'a> {
    store: &'a AutomationStore,
    ports: Ports<'a>,
    ids: CounterIds,
    lives: Lifecycle,
    revision: u64,
    watches: HashMap<String, Watch>,
    /// Runs whose executor work is being followed, aborted by stop.
    pending: HashSet<String>,
    published: Vec<Value>,
    actions: Vec<Action>,
    generation: u64,
}

impl<'a> Service<'a> {
    pub fn new(store: &'a AutomationStore, ports: Ports<'a>) -> Service<'a> {
        let next = store.max_run_seq().unwrap_or(0);
        Service {
            store,
            ports,
            ids: CounterIds::with_start("run", next),
            lives: Lifecycle::new(),
            revision: 0,
            watches: HashMap::new(),
            pending: HashSet::new(),
            published: Vec::new(),
            actions: Vec::new(),
            generation: 0,
        }
    }

    pub fn live(&self) -> bool {
        self.lives.live()
    }

    pub fn take_published(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.published)
    }

    pub fn take_actions(&mut self) -> Vec<Action> {
        std::mem::take(&mut self.actions)
    }

    fn scheduler(&self) -> Scheduler<'_> {
        Scheduler::new(
            self.store,
            self.ports.clock,
            self.ports.random,
            self.ports.admission,
        )
    }

    fn now(&self) -> i64 {
        self.ports.clock.now_ms()
    }

    fn publish(&mut self, run: &Value) {
        self.published.push(run.clone());
    }

    /// Start (`service.ts:113`): install watchers, recover schedule cursors, follow every durable
    /// run, hand standing cancellations over and start what waited.
    pub fn start(&mut self) -> Result<()> {
        if !self.lives.begin_start() {
            return Ok(());
        }
        self.generation += 1;
        let generation = self.generation;
        self.watches.clear();
        let scheduler = Scheduler::new(
            self.store,
            self.ports.clock,
            self.ports.random,
            self.ports.admission,
        );
        let _ = scheduler.start()?;
        let jobs = self.store.list()?;
        for job in jobs {
            if !self.lives.live() || generation != self.generation {
                break;
            }
            if let Err(error) = self.prepare_watch(&job.automation) {
                let _ = self.save_watch_error(&job.automation.id, &error);
            }
        }
        for (run, input) in self.store.active()? {
            if !self.lives.live() {
                break;
            }
            if let Some(run_id) = run_id(&run) {
                self.pending.insert(run_id.clone());
                self.actions.push(Action::Recover { run_id, input });
            }
        }
        for (run, input) in self.store.cancelling()? {
            if !self.lives.live() {
                break;
            }
            if let Some(run_id) = run_id(&run) {
                self.actions.push(Action::Interrupt { run_id, input });
            }
        }
        self.drain_waiting();
        self.finish_start();
        Ok(())
    }

    fn finish_start(&mut self) {
        if self.lives.end_start() {
            self.stop();
        }
    }

    pub fn stop(&mut self) {
        if !self.lives.begin_stop() {
            return;
        }
        self.generation += 1;
        let watches: Vec<Watch> = self.watches.drain().map(|(_, watch)| watch).collect();
        self.pending.clear();
        self.actions.clear();
        for watch in watches {
            if let Some(workspace) = self.ports.workspace {
                workspace.unsubscribe(&watch.workspace);
            }
        }
        self.lives.end_stop();
    }

    fn prepare_watch(&mut self, automation: &Definition) -> Result<()> {
        if !self.lives.live() || !automation.enabled || automation.trigger.kind() != "file" {
            self.drop_watch(&automation.id);
            return Ok(());
        }
        let Some(workspace_port) = self.ports.workspace else {
            return Ok(());
        };
        let Trigger::File { paths } = &automation.trigger else {
            return Ok(());
        };
        self.revision += 1;
        let revision = self.revision;
        self.drop_watch(&automation.id);
        workspace_port
            .subscribe(&automation.workspace, paths)
            .map_err(AutomationsError::message)?;
        self.watches.insert(
            automation.id.clone(),
            Watch {
                workspace: automation.workspace.clone(),
                revision,
            },
        );
        Ok(())
    }

    fn drop_watch(&mut self, id: &str) {
        if let Some(watch) = self.watches.remove(id)
            && let Some(workspace) = self.ports.workspace
        {
            workspace.unsubscribe(&watch.workspace);
        }
    }

    fn watch_current(&self, id: &str) -> Option<u64> {
        self.watches.get(id).map(|watch| watch.revision)
    }

    /// The watcher reported readiness: clear the trigger's stored error if it is still current.
    pub fn watch_ready(&mut self, id: &str, revision: u64) -> Result<()> {
        if !self.lives.live() || self.watch_current(id) != Some(revision) {
            return Ok(());
        }
        self.store.clear_trigger_error(id)
    }

    /// The watcher failed: persist health and drop the failed watch.
    pub fn watch_error(&mut self, id: &str, revision: u64, message: &str) -> Result<()> {
        if !self.lives.live() || self.watch_current(id) != Some(revision) {
            return Ok(());
        }
        self.save_watch_error(id, &AutomationsError::message(message.to_owned()))?;
        self.drop_watch(id);
        Ok(())
    }

    fn save_watch_error(&mut self, id: &str, error: &AutomationsError) -> Result<()> {
        let mut body = Map::new();
        body.insert("message", Value::String(error.to_string().as_str().into()));
        body.insert("at", Value::Number(self.now().into()));
        self.store.save_trigger_error(id, &Value::Object(body))
    }

    /// A file change from the workspace, after the watcher's own debounce and dedupe.
    pub fn receive_file_event(
        &mut self,
        id: &str,
        key: &str,
        variables: BTreeMap<String, String>,
    ) -> Result<()> {
        if !self.lives.live() || self.watch_current(id).is_none() {
            return Ok(());
        }
        self.trigger(id, key, variables, "file", None)?;
        Ok(())
    }

    /// `put` (`service.ts:313`): the definition, its occurrence and its jittered deadline commit
    /// together; a pause commits with its cancellations; file health clears only on readiness.
    pub fn put(
        &mut self,
        definition: &Definition,
        expected_revision: Option<Option<i64>>,
    ) -> Result<Definition> {
        let existing = self.store.definition(&definition.id)?;
        if expected_revision == Some(None) && existing.is_some() {
            return Err(AutomationsError::message("Automation already exists"));
        }
        if let Some(Some(expected)) = expected_revision {
            if existing.is_none() {
                return Err(AutomationsError::message("Automation is missing"));
            }
            if self.store.revision(&definition.id)? != Some(expected) {
                return Err(AutomationsError::message("Automation revision conflict"));
            }
        }
        if existing.as_ref() == Some(definition) {
            if self.lives.live()
                && definition.enabled
                && definition.trigger.kind() == "file"
                && self.watch_current(&definition.id).is_none()
            {
                self.prepare_watch(definition)?;
                self.store.clear_trigger_error(&definition.id)?;
            }
            return Ok(definition.clone());
        }
        let pausing = existing.as_ref().is_some_and(|old| old.enabled) && !definition.enabled;
        let prepared =
            if self.lives.live() && definition.enabled && definition.trigger.kind() == "file" {
                self.prepare_watch(definition)
            } else {
                self.drop_watch(&definition.id);
                Ok(())
            };
        if let Err(error) = prepared {
            // A replacement failure keeps the previous definition and watcher; a new id persists as
            // unhealthy so one stale workspace cannot block saves.
            if existing.is_some() {
                return Err(error);
            }
            self.store.put(
                definition,
                None,
                None,
                &Value::Object(Map::new()),
                expected_revision,
            )?;
            self.save_watch_error(&definition.id, &error)?;
            return Ok(definition.clone());
        }
        let now = self.now();
        let recurrence = scheduler_recurrence(definition)?;
        let occurrence = if definition.enabled {
            recurrence
                .as_ref()
                .map(|recurrence| recurrence.seek(now - 1, None))
                .transpose()?
                .flatten()
        } else {
            None
        };
        let nominal = occurrence.map(|occurrence| occurrence.at);
        let due = if !definition.enabled {
            None
        } else if definition.trigger.kind() == "github" {
            Some(now)
        } else {
            match &recurrence {
                Some(recurrence) => crate::decisions::scheduled_deadline(
                    occurrence,
                    recurrence,
                    definition.jitter_ms,
                    self.ports.random.draw(),
                )?,
                None => None,
            }
        };
        let skipped = self.store.transaction(|| {
            self.store.put(
                definition,
                nominal,
                due,
                &occurrence_value(occurrence),
                expected_revision,
            )?;
            if pausing {
                self.store
                    .halt(&definition.id, now, "Paused before it started")
            } else {
                Ok(Vec::new())
            }
        })?;
        for run in skipped {
            self.publish(&run);
        }
        self.carry_out(Some(&definition.id));
        if definition.trigger.kind() != "file" {
            self.drop_watch(&definition.id);
        }
        self.arm();
        Ok(definition.clone())
    }

    /// Stop an automation's work and forget it (`service.ts:423`).
    pub fn remove(
        &mut self,
        id: &str,
        expected_revision: Option<Option<i64>>,
    ) -> Result<Vec<Value>> {
        let skipped = self.store.transaction(|| {
            self.store.remove(id, expected_revision)?;
            self.store.halt(id, self.now(), "Deleted before it started")
        })?;
        for run in &skipped {
            self.publish(run);
        }
        self.carry_out(Some(id));
        self.drop_watch(id);
        self.arm();
        Ok(skipped)
    }

    pub fn set_enabled(
        &mut self,
        id: &str,
        enabled: bool,
        expected_revision: Option<i64>,
    ) -> Result<()> {
        let Some(mut current) = self.store.definition(id)? else {
            return Err(AutomationsError::message("Automation is missing"));
        };
        current.enabled = enabled;
        self.put(&current, expected_revision.map(Some))?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Definition>> {
        Ok(self
            .store
            .list()?
            .into_iter()
            .map(|job| job.automation)
            .collect())
    }

    pub fn catalog(&self, provider: &str, workspace: &str) -> Result<Vec<(String, String)>> {
        self.store.catalog(provider, workspace)
    }

    pub fn inbox(
        &self,
        limit: usize,
        before: Option<i64>,
        automation_id: Option<&str>,
        finished_after: Option<i64>,
    ) -> Result<(Vec<Value>, Option<i64>)> {
        self.store
            .inbox(limit, before, automation_id, finished_after)
    }

    pub fn next_run_at(&self, id: &str) -> Result<Option<i64>> {
        Ok(self.store.metadata(id)?.and_then(|job| job.due))
    }

    /// Admit one run (`service.ts:450`). Manual runs refuse when new work is paused; fires are
    /// recorded as skipped instead.
    pub fn trigger(
        &mut self,
        id: &str,
        key: &str,
        variables: BTreeMap<String, String>,
        kind: &str,
        note: Option<&str>,
    ) -> Result<Value> {
        if !self.lives.live() {
            return Err(AutomationsError::message("Automation service is stopped"));
        }
        let generation = self.generation;
        let Some(definition) = self.store.definition(id)? else {
            return Err(AutomationsError::message(
                "Automation is disabled or missing",
            ));
        };
        if !definition.enabled {
            return Err(AutomationsError::message(
                "Automation is disabled or missing",
            ));
        }
        if kind == "manual" && !self.ports.admission.open() {
            return Err(AutomationsError::message(
                self.ports
                    .admission
                    .closed_reason()
                    .unwrap_or_else(|| PAUSED_REFUSAL.to_owned()),
            ));
        }
        validate_event(key, &variables)?;
        let (claimed, input) = self.admit(&definition, key, &variables, kind, note)?;
        if claimed.created {
            self.publish(&claimed.run);
        }
        if claimed.admitted
            && let Some(input) = input
            && self.lives.live()
            && generation == self.generation
            && let Some(run_id) = run_id(&claimed.run)
        {
            self.pending.insert(run_id.clone());
            self.actions.push(Action::Execute { run_id, input });
        }
        self.arm();
        Ok(claimed.run)
    }

    fn admit(
        &mut self,
        automation: &Definition,
        key: &str,
        variables: &BTreeMap<String, String>,
        kind: &str,
        note: Option<&str>,
    ) -> Result<(crate::store::ClaimedRun, Option<Value>)> {
        let run_id = if kind == "manual" {
            manual_id(&automation.id, key)
        } else {
            self.ids.next_id()
        };
        let webhook = automation.trigger.kind() == "webhook";
        let access = run_access(automation.access.as_deref(), webhook);
        let mut input = Map::new();
        let rendered = render_prompt(&automation.prompt, variables).and_then(|prompt| {
            let prompt = if kind == "webhook" {
                with_webhook_note(&prompt, &automation.prompt)?
            } else {
                prompt
            };
            with_run_note(&prompt, note)
        });
        let failure = match rendered {
            Ok(prompt) => {
                input.insert("idempotencyKey", Value::String(run_id.as_str().into()));
                input.insert("automationId", Value::String(automation.id.as_str().into()));
                input.insert("title", Value::String(automation.title.as_str().into()));
                input.insert(
                    "provider",
                    Value::String(automation.provider.as_str().into()),
                );
                input.insert(
                    "workspace",
                    Value::String(automation.workspace.as_str().into()),
                );
                input.insert("worktree", Value::Bool(automation.worktree));
                input.insert("prompt", Value::String(prompt.as_str().into()));
                if let Some(model) = &automation.model {
                    input.insert("model", Value::String(model.as_str().into()));
                }
                if let Some(effort) = &automation.effort {
                    input.insert("effort", Value::String(effort.as_str().into()));
                }
                if let Some(instance) = &automation.instance {
                    input.insert("instance", Value::String(instance.as_str().into()));
                }
                if let Some(access) = &access {
                    input.insert("access", Value::String(access.as_str().into()));
                    if webhook {
                        input.insert("accessCeiling", Value::String(access.as_str().into()));
                    }
                }
                None
            }
            Err(error) => Some(error.to_string()),
        };
        let skip = if self.ports.admission.open() {
            None
        } else {
            Some(
                self.ports
                    .admission
                    .closed_reason()
                    .unwrap_or_else(|| PAUSED_RESULT.to_owned()),
            )
        };
        let input = failure.is_none().then(|| Value::Object(input));
        let claimed = self.store.claim(
            automation,
            &Claim {
                event_key: key,
                trigger: kind,
                id: &run_id,
                now: self.now(),
                input: input.as_ref(),
                failure: failure.as_deref(),
                skip: skip.as_deref(),
            },
        )?;
        Ok((claimed, input))
    }

    /// One due schedule's turn (`service.ts:661`), then the waiting queue.
    pub fn tick(&mut self) -> Result<Option<Value>> {
        if !self.lives.live() {
            return Ok(None);
        }
        let generation = self.generation;
        let mut ids = std::mem::replace(&mut self.ids, CounterIds::new("run"));
        let outcome = self.scheduler().tick(&mut ids);
        self.ids = ids;
        let outcome = outcome?;
        let run = outcome.run.map(|claimed| claimed.run);
        if let Some(run) = &run
            && run_status(run).as_deref() == Some("running")
            && self.lives.live()
            && generation == self.generation
            && let Some(input) = outcome.input
            && let Some(run_id) = run_id(run)
        {
            self.pending.insert(run_id.clone());
            self.actions.push(Action::Execute { run_id, input });
        }
        if let Some(run) = &run {
            self.publish(run);
        }
        self.arm();
        Ok(run)
    }

    /// The scheduler's timer delay (`service.ts:617`).
    pub fn arm_delay(&self) -> Result<Option<i64>> {
        if !self.lives.live() {
            return Ok(None);
        }
        let Some(job) = self.store.next_scheduled()? else {
            return Ok(None);
        };
        let Some(due) = job.due else {
            return Ok(None);
        };
        Ok(Some(
            (due - self.now()).clamp(0, crate::scheduler::MAX_TIMER_DELAY_MS),
        ))
    }

    /// The host arms its one timer from [`Service::arm_delay`]; this is its re-arm point.
    fn arm(&mut self) {}

    /// Poll one GitHub automation (`service.ts:703`) through the host's `gh` client: the state
    /// commits only if the definition did not change under the request, and each delivered event
    /// is admitted as a GitHub run.
    pub fn poll_github_now(
        &mut self,
        id: &str,
        client: &dyn crate::github::GhClient,
    ) -> Result<Vec<Value>> {
        if !self.lives.live() {
            return Ok(Vec::new());
        }
        let revision = self.store.revision(id)?;
        let Some(definition) = self.store.definition(id)? else {
            return Ok(Vec::new());
        };
        let Trigger::Github {
            repository,
            event,
            label,
            pull_request,
            poll_interval_ms,
        } = definition.trigger.clone()
        else {
            return Ok(Vec::new());
        };
        let trigger = crate::github::GithubTrigger {
            repository,
            event,
            label,
            pull_request,
            poll_interval_ms,
        };
        let state = self.store.read_state(id)?;
        match crate::github::poll_github(client, &trigger, &state) {
            Ok(poll) => {
                if self.store.revision(id)? != revision {
                    return Ok(Vec::new());
                }
                self.store.transaction(|| {
                    if poll.changed {
                        let text = ace_json::ser::to_string(&poll.state)
                            .map_err(|error| AutomationsError::message(error.to_string()))?;
                        let value = ace_json::parse(&text)
                            .map_err(|error| AutomationsError::message(error.to_string()))?;
                        self.store.save_poll(id, &value)?;
                    }
                    self.store.clear_poll_error(id)?;
                    self.store.clear_trigger_error(id)
                })?;
                let mut runs = Vec::new();
                for event in poll.events {
                    if self.store.revision(id)? != revision {
                        break;
                    }
                    runs.push(self.trigger(id, &event.key, event.variables, "github", None)?);
                }
                self.arm();
                Ok(runs)
            }
            Err(error) => {
                if self.store.revision(id)? == revision {
                    let mut failure = Map::new();
                    failure.insert("message", Value::String(error.to_string().as_str().into()));
                    failure.insert("at", Value::Number(self.now().into()));
                    let failure = Value::Object(failure);
                    let _ = self.store.save_poll_error(id, &failure);
                    let _ = self.store.save_trigger_error(id, &failure);
                }
                Err(error)
            }
        }
    }

    /// A run's executor settled (`execution-owner.ts:122`).
    pub fn complete(
        &mut self,
        run_id: &str,
        status: &str,
        thread_id: Option<&str>,
        result: Option<&str>,
    ) -> Result<Option<Value>> {
        if !self.lives.live() || !self.pending.contains(run_id) {
            return Ok(None);
        }
        self.pending.remove(run_id);
        let finished = self
            .store
            .finish(run_id, self.now(), status, thread_id, result)?;
        if let Some(run) = &finished {
            self.publish(run);
        }
        self.drain_waiting();
        Ok(finished)
    }

    /// Recovery found nothing to follow (`execution-owner.ts:69`): send the stored input once.
    pub fn recovery_empty(&mut self, run_id: &str) -> Result<()> {
        if !self.lives.live() || !self.pending.contains(run_id) {
            return Ok(());
        }
        if self.store.cancellation(run_id)?.is_some() {
            self.pending.remove(run_id);
            self.store.finish(
                run_id,
                self.now(),
                "failed",
                None,
                Some("Stopped before it started."),
            )?;
            return Ok(());
        }
        if let Some(input) = self.store.run_input(run_id)? {
            self.actions.push(Action::Execute {
                run_id: run_id.to_owned(),
                input,
            });
        }
        Ok(())
    }

    /// Hand standing cancellations to the executor (`cancellations.ts:31`), optionally only one
    /// automation's.
    pub fn carry_out(&mut self, automation_id: Option<&str>) {
        if !self.lives.live() {
            return;
        }
        let Ok(cancelling) = self.store.cancelling() else {
            return;
        };
        for (run, input) in cancelling {
            let id = run_automation(&run);
            if automation_id.is_some_and(|only| Some(only) != id.as_deref()) {
                continue;
            }
            if let Some(run_id) = run_id(&run) {
                self.actions.push(Action::Interrupt { run_id, input });
            }
        }
    }

    /// Start every waiting run that may start now, oldest first (`service.ts:271`).
    pub fn drain_waiting(&mut self) {
        if !self.lives.live() || !self.ports.admission.open() {
            return;
        }
        let Ok(waiting) = self.store.waiting_automations() else {
            return;
        };
        for id in waiting {
            if !self.lives.live() {
                return;
            }
            let generation = self.generation;
            let Ok(Some(definition)) = self.store.definition(&id) else {
                continue;
            };
            if !definition.enabled {
                continue;
            }
            let promoted = self
                .store
                .transaction(|| self.store.promote(&definition, self.now()));
            let Ok(Some((run, input))) = promoted else {
                continue;
            };
            self.publish(&run);
            if self.lives.live()
                && generation == self.generation
                && let Some(run_id) = run_id(&run)
            {
                self.pending.insert(run_id.clone());
                self.actions.push(Action::Execute { run_id, input });
            }
        }
    }

    /// Retry a broken trigger (`service.ts:758`): a file watcher again, a schedule's cursor and
    /// deadline again, a GitHub poll now.
    pub fn retry(&mut self, id: &str, expected_revision: Option<i64>) -> Result<()> {
        if !self.lives.live() {
            return Err(AutomationsError::message("Automation service is stopped"));
        }
        let Some(definition) = self.store.definition(id)? else {
            return Err(AutomationsError::message("Automation is missing"));
        };
        if let Some(expected) = expected_revision
            && self.store.revision(id)? != Some(expected)
        {
            return Err(AutomationsError::message("Automation revision conflict"));
        }
        if !definition.enabled {
            return Err(AutomationsError::message(
                "Automation is disabled or missing",
            ));
        }
        match &definition.trigger {
            Trigger::File { .. } => {
                self.prepare_watch(&definition)?;
                if let Some(revision) = self.watch_current(id) {
                    let _ = revision;
                }
                self.store.clear_trigger_error(id)?;
            }
            Trigger::Schedule { schedule } => {
                let recurrence = crate::recurrence::Recurrence::compile(schedule.clone())?;
                let state = self.store.read_state(id)?;
                let cursor: Occurrence = ace_json::from_value(&state)
                    .map_err(|_| AutomationsError::message("Invalid counted cursor"))?;
                let occurrence = recurrence.seek(self.now() - 1, Some(cursor))?;
                let due = crate::decisions::scheduled_deadline(
                    occurrence,
                    &recurrence,
                    definition.jitter_ms,
                    self.ports.random.draw(),
                )?;
                self.store.transaction(|| {
                    self.store
                        .advance(id, occurrence.map(|value| value.at), due)?;
                    self.store.save_poll(id, &occurrence_value(occurrence))?;
                    self.store.clear_trigger_error(id)
                })?;
            }
            Trigger::Github { .. } => {
                self.store.advance(
                    id,
                    self.store.metadata(id)?.and_then(|job| job.nominal),
                    Some(self.now()),
                )?;
            }
            Trigger::Manual | Trigger::Webhook => {}
        }
        Ok(())
    }

    /// Every `AutomationRequest` envelope (`service.ts:800`).
    pub fn handle(&mut self, request: &Value) -> Value {
        let object = match request {
            Value::Object(object) => object,
            _ => return result_error("", "Invalid automation request"),
        };
        let request_id = object
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
        let outcome =
            (|| -> Result<Map> {
                let mut result = Map::new();
                result.insert("type", Value::String("automation.result".into()));
                result.insert("requestId", Value::String(request_id.as_str().into()));
                match kind {
                    "automation.put" => {
                        let automation = object.get("automation").ok_or_else(|| {
                            AutomationsError::message("Invalid automation request")
                        })?;
                        let definition: Definition = ace_json::from_value(automation)?;
                        let expected = expected_revision(object.get("expectedRevision"))?;
                        self.put(&definition, expected)?;
                    }
                    "automation.remove" => {
                        let id = object.get("id").and_then(Value::as_str).ok_or_else(|| {
                            AutomationsError::message("Invalid automation request")
                        })?;
                        self.remove(id, expected_revision(object.get("expectedRevision"))?)?;
                    }
                    "automation.setEnabled" => {
                        let id = object.get("id").and_then(Value::as_str).ok_or_else(|| {
                            AutomationsError::message("Invalid automation request")
                        })?;
                        let enabled = object
                            .get("enabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let expected = object.get("expectedRevision").and_then(Value::as_i64);
                        self.set_enabled(id, enabled, expected)?;
                    }
                    "automation.retry" => {
                        let id = object.get("id").and_then(Value::as_str).ok_or_else(|| {
                            AutomationsError::message("Invalid automation request")
                        })?;
                        let expected = object.get("expectedRevision").and_then(Value::as_i64);
                        self.retry(id, expected)?;
                    }
                    "automation.run" => {
                        let id = object.get("id").and_then(Value::as_str).ok_or_else(|| {
                            AutomationsError::message("Invalid automation request")
                        })?;
                        let key = format!("manual:{request_id}");
                        let variables = variables(object.get("variables"))?;
                        let note = object.get("message").and_then(Value::as_str);
                        let run = self.trigger(id, &key, variables, "manual", note)?;
                        result.insert("run", run);
                    }
                    "automation.list" => {
                        let jobs = self.store.list()?;
                        let runs: HashMap<String, Value> =
                            self.store.latest_runs()?.into_iter().collect();
                        let automations: Vec<Value> = jobs
                            .iter()
                            .map(|job| serialize_value(&job.automation))
                            .collect::<Result<_>>()?;
                        let schedules: Vec<Value> = jobs
                            .iter()
                            .map(|job| {
                                schedule_entry(job, self.lives.live(), runs.get(&job.automation.id))
                            })
                            .collect();
                        result.insert("automations", Value::Array(automations.into()));
                        result.insert("schedules", Value::Array(schedules.into()));
                    }
                    "automation.inbox" => {
                        let limit = object
                            .get("limit")
                            .and_then(Value::as_i64)
                            .unwrap_or(50)
                            .clamp(1, 100) as usize;
                        let before = object.get("before").and_then(Value::as_i64);
                        let automation_id = object.get("automationId").and_then(Value::as_str);
                        let finished_after = object.get("finishedAfter").and_then(Value::as_i64);
                        let (runs, next) =
                            self.inbox(limit, before, automation_id, finished_after)?;
                        let mut inbox = Map::new();
                        inbox.insert("runs", Value::Array(runs.into()));
                        inbox.insert(
                            "before",
                            next.map_or(Value::Null, |value| Value::Number(value.into())),
                        );
                        result.insert("inbox", Value::Object(inbox));
                    }
                    _ => return Err(AutomationsError::message("Invalid automation request")),
                }
                result.insert("ok", Value::Bool(true));
                Ok(result)
            })();
        match outcome {
            Ok(result) => Value::Object(result),
            Err(error) => result_error(&request_id, &error.to_string()),
        }
    }
}

fn result_error(request_id: &str, message: &str) -> Value {
    let mut result = Map::new();
    result.insert("type", Value::String("automation.result".into()));
    result.insert("requestId", Value::String(request_id.into()));
    result.insert("ok", Value::Bool(false));
    result.insert("error", Value::String(message.into()));
    Value::Object(result)
}

fn expected_revision(value: Option<&Value>) -> Result<Option<Option<i64>>> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(value) => value
            .as_i64()
            .map(|revision| Some(Some(revision)))
            .ok_or_else(|| AutomationsError::message("Invalid automation request")),
    }
}

fn variables(value: Option<&Value>) -> Result<BTreeMap<String, String>> {
    let Some(Value::Object(object)) = value else {
        return Err(AutomationsError::message("Invalid automation request"));
    };
    let mut variables = BTreeMap::new();
    for (key, value) in object.iter() {
        let Some(value) = value.as_str() else {
            return Err(AutomationsError::message("Invalid automation request"));
        };
        variables.insert(key.to_string(), value.to_owned());
    }
    Ok(variables)
}

fn validate_event(key: &str, variables: &BTreeMap<String, String>) -> Result<()> {
    if key.is_empty() || key.encode_utf16().count() > 512 {
        return Err(AutomationsError::message("Invalid trigger event key"));
    }
    if variables.len() > 64 {
        return Err(AutomationsError::message("Invalid trigger variables"));
    }
    for (name, value) in variables {
        let mut bytes = name.bytes();
        let valid = bytes
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic())
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.');
        if !valid || name.len() > 128 || value.chars().count() > 8192 {
            return Err(AutomationsError::message("Invalid trigger variables"));
        }
    }
    Ok(())
}

/// A manual run's deterministic key survives run-history eviction (`service.ts:44`).
pub fn manual_id(automation_id: &str, event_key: &str) -> String {
    let scoped = format!(
        "{}:{automation_id}:{event_key}",
        automation_id.encode_utf16().count()
    );
    let digest = Sha256::digest(scoped.as_bytes());
    format!("manual-{digest:x}")
}

fn run_id(run: &Value) -> Option<String> {
    match run {
        Value::Object(map) => map.get("id").and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
}

fn run_automation(run: &Value) -> Option<String> {
    match run {
        Value::Object(map) => map
            .get("automationId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        _ => None,
    }
}

fn run_status(run: &Value) -> Option<String> {
    match run {
        Value::Object(map) => map.get("status").and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
}

fn occurrence_value(occurrence: Option<Occurrence>) -> Value {
    let mut cursor = Map::new();
    if let Some(occurrence) = occurrence {
        cursor.insert("at", Value::Number(occurrence.at.into()));
        cursor.insert(
            "ordinal",
            Value::Number(i64::from(occurrence.ordinal).into()),
        );
    }
    Value::Object(cursor)
}

fn scheduler_recurrence(definition: &Definition) -> Result<Option<crate::recurrence::Recurrence>> {
    definition
        .schedule()
        .map(|schedule| crate::recurrence::Recurrence::compile(schedule.clone()))
        .transpose()
}

fn serialize_value<T: serde::Serialize>(value: &T) -> Result<Value> {
    let text = ace_json::ser::to_string(value)
        .map_err(|error| AutomationsError::message(error.to_string()))?;
    ace_json::parse(&text).map_err(|error| AutomationsError::message(error.to_string()))
}

fn schedule_entry(job: &JobMetadata, live: bool, last_run: Option<&Value>) -> Value {
    let mut entry = Map::new();
    entry.insert("id", Value::String(job.automation.id.as_str().into()));
    entry.insert(
        "nextRunAt",
        if live {
            job.due.map_or(Value::Null, |due| Value::Number(due.into()))
        } else {
            Value::Null
        },
    );
    entry.insert("revision", Value::Number(job.revision.into()));
    if let Some(error) = &job.last_poll_error {
        entry.insert("lastPollError", error.clone());
    }
    if let Some(error) = &job.trigger_error {
        let mut body = Map::new();
        body.insert("message", Value::String(error.message.as_str().into()));
        body.insert("at", Value::Number(error.at.into()));
        entry.insert("triggerError", Value::Object(body));
    }
    if let Some(run) = last_run {
        entry.insert("lastRun", run.clone());
    }
    Value::Object(entry)
}
