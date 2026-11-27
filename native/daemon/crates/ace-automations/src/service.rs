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

use crate::error::{AutomationsError, Result};
use crate::recurrence::Occurrence;
use crate::scheduler::MAX_TIMER_DELAY_MS;
use crate::scheduler::{Admission, Clock, IdSource, Random, Scheduler};
use crate::store::{AutomationStore, Definition, JobMetadata, Trigger};

mod envelopes;
mod runs;
mod watches;

/// What the host must do, in order, after a service call.
#[derive(Debug, Clone)]
pub enum Action {
    /// Start the run's thread with this input.
    Execute { run_id: String, input: Value },
    /// Follow work a previous boot left behind; `recovery_empty` follows an empty answer.
    Recover { run_id: String, input: Value },
    /// Stop the run's thread; the run settles through its monitor.
    Interrupt { run_id: String, input: Value },
    /// Poll this GitHub automation; the host answers through [`Service::poll_github_now`].
    PollGithub { automation_id: String },
}

/// File watching, owned by the host (`WorkspaceChanges`, `contracts.ts:53`). Subscribe may fail
/// synchronously and returns an owned subscription, so a replacement can be prepared beside the
/// old watcher and installed only after the save commits. Readiness arrives later through
/// [`Service::watch_ready`].
pub trait Workspace {
    fn subscribe(&self, workspace: &str, paths: &[String]) -> std::result::Result<u64, String>;
    fn unsubscribe(&self, subscription: u64);
}

/// The one timer's host (`contracts.ts:50`). `arm` replaces any previous timer; a failure is
/// reported and never stops durable scheduling.
pub trait TimerPort {
    fn arm(&self, delay_ms: i64) -> std::result::Result<(), String>;
    fn cancel(&self) -> std::result::Result<(), String>;
}

/// A timer port for hosts and tests that drive deadlines themselves.
pub struct NoopTimer;

impl TimerPort for NoopTimer {
    fn arm(&self, _delay_ms: i64) -> std::result::Result<(), String> {
        Ok(())
    }

    fn cancel(&self) -> std::result::Result<(), String> {
        Ok(())
    }
}

pub struct Ports<'a> {
    pub clock: &'a dyn Clock,
    pub random: &'a dyn Random,
    pub admission: &'a dyn Admission,
    pub timer: &'a dyn TimerPort,
    /// Restart-safe generated ids for non-manual runs; the host's own generator.
    pub ids: &'a dyn IdSource,
    pub workspace: Option<&'a dyn Workspace>,
    /// Whether discovery for this automation's provider is still running.
    pub model_loading: Option<&'a dyn Fn(&Definition) -> bool>,
    /// How long one occurrence waits for discovery before its model counts as unavailable.
    pub model_hold_ms: Option<i64>,
    /// How often a held schedule checks again when no readiness wake arrives.
    pub model_retry_ms: Option<i64>,
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
    subscription: u64,
    revision: u64,
}

/// A subscription prepared before its definition is committed. It owns the host's watcher until
/// it is installed or discarded.
struct PreparedWatch {
    subscription: u64,
    revision: u64,
}

pub struct Service<'a> {
    store: &'a AutomationStore,
    ports: Ports<'a>,
    lives: Lifecycle,
    revision: u64,
    watches: HashMap<String, Watch>,
    /// Runs whose executor work is being followed, aborted by stop.
    pending: HashSet<String>,
    published: Vec<Value>,
    actions: Vec<Action>,
    generation: u64,
    timer: Option<TimerArm>,
    /// Interrupt hand-offs that failed and when they are tried again, per run.
    retries: HashMap<String, Retry>,
    /// How many interrupt attempts each run has had, kept across a hand-off so the backoff never
    /// starts over.
    interrupt_attempts: HashMap<String, u32>,
    /// Settled runs whose terminal write was refused: the outcome and ownership are kept until
    /// SQLite accepts them, and the timer tries again.
    finishes: HashMap<String, Finish>,
    /// Due schedules held for model discovery: `id\0nominal` to the tick that first held it.
    held: HashMap<String, i64>,
    errors: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
struct TimerArm {
    delay_ms: i64,
}

#[derive(Debug, Clone, Copy)]
struct Retry {
    due: i64,
}

/// How long one occurrence waits for model discovery before its model counts as unavailable.
const MODEL_HOLD_MS: i64 = 30_000;
/// How often a held schedule checks again when no readiness wake arrives.
const MODEL_RETRY_MS: i64 = 30_000;

#[derive(Debug, Clone)]
struct Finish {
    status: String,
    thread_id: Option<String>,
    result: Option<String>,
    due: i64,
}

impl<'a> Service<'a> {
    pub fn new(store: &'a AutomationStore, ports: Ports<'a>) -> Service<'a> {
        Service {
            store,
            ports,
            lives: Lifecycle::new(),
            revision: 0,
            watches: HashMap::new(),
            pending: HashSet::new(),
            published: Vec::new(),
            actions: Vec::new(),
            generation: 0,
            timer: None,
            retries: HashMap::new(),
            interrupt_attempts: HashMap::new(),
            finishes: HashMap::new(),
            held: HashMap::new(),
            errors: Vec::new(),
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

    fn hold_key(id: &str, nominal: Option<i64>) -> String {
        format!("{id}\u{0}{}", nominal.unwrap_or(0))
    }

    fn clear_holds(&mut self, id: &str) {
        let prefix = format!("{id}\u{0}");
        self.held.retain(|key, _| !key.starts_with(&prefix));
    }

    /// Automations whose held occurrence is still inside its wait. A hold past its window keeps
    /// its stamp until the occurrence is consumed, but no longer keeps the job from firing.
    fn held_ids(&self, now: i64) -> HashSet<String> {
        let hold = self.ports.model_hold_ms.unwrap_or(MODEL_HOLD_MS);
        self.held
            .iter()
            .filter(|(_, since)| now - **since < hold)
            .filter_map(|(key, _)| key.split('\u{0}').next().map(str::to_owned))
            .collect()
    }

    /// The next job that may fire (`service.ts:565`). A due schedule whose model discovery is
    /// still running is held per occurrence, so it keeps its place instead of being spent on a
    /// thread the engine would refuse, beaten only by [`Ports::model_hold_ms`].
    fn next_due(&mut self, now: i64) -> Result<Option<JobMetadata>> {
        let mut skip: HashSet<String> = HashSet::new();
        loop {
            let Some(job) = self.store.next_skipping(&skip)? else {
                return Ok(None);
            };
            if job.automation.trigger.kind() != "schedule" {
                return Ok(Some(job));
            }
            let Some(loading) = self.ports.model_loading else {
                return Ok(Some(job));
            };
            let id = job.automation.id.clone();
            let key = Service::hold_key(&id, job.nominal);
            let prefix = format!("{id}\u{0}");
            // A newer occurrence replaces an older one's hold; only then does its wait restart.
            self.held
                .retain(|existing, _| !existing.starts_with(&prefix) || existing == &key);
            if !loading(&job.automation) {
                self.held.remove(&key);
                return Ok(Some(job));
            }
            let hold = self.ports.model_hold_ms.unwrap_or(MODEL_HOLD_MS);
            // Expiry is not consumed here: [`Service::arm_delay`] asks for the next job too, and
            // deleting the stamp would let the next tick start the same occurrence's wait over.
            // It lives until the occurrence is consumed or a newer one replaces it.
            if let Some(since) = self.held.get(&key)
                && now - *since >= hold
            {
                return Ok(Some(job));
            }
            self.held.entry(key).or_insert(now);
            skip.insert(id);
        }
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
        let result = self.start_inner();
        if result.is_err() {
            // A failed start still owns what it prepared: mark the requested stop while the
            // phase is starting, then let the start's own end perform the teardown below.
            self.lives.begin_stop();
        }
        self.finish_start();
        result
    }

    fn start_inner(&mut self) -> Result<()> {
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
            match self.prepare_watch(&job.automation) {
                Ok(Some(prepared)) => self.install_watch(&job.automation.id, prepared),
                Ok(None) => self.drop_watch(&job.automation.id),
                Err(error) => {
                    let _ = self.save_watch_error(&job.automation.id, &error);
                }
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
        self.arm();
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
        self.retries.clear();
        self.interrupt_attempts.clear();
        self.finishes.clear();
        self.held.clear();
        self.cancel_timer();
        for watch in watches {
            if let Some(workspace) = self.ports.workspace {
                workspace.unsubscribe(watch.subscription);
            }
        }
        self.lives.end_stop();
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
                match self.prepare_watch(definition) {
                    Ok(Some(prepared)) => self.install_watch(&definition.id, prepared),
                    Ok(None) => {}
                    Err(error) => self.save_watch_error(&definition.id, &error)?,
                }
            }
            return Ok(definition.clone());
        }
        let pausing = existing.as_ref().is_some_and(|old| old.enabled) && !definition.enabled;
        let prepared =
            if self.lives.live() && definition.enabled && definition.trigger.kind() == "file" {
                self.prepare_watch(definition)
            } else {
                Ok(None)
            };
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                // A replacement failure keeps the previous definition and watcher; a new id
                // persists as unhealthy so one stale workspace cannot block saves.
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
        };
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
        });
        let skipped = match skipped {
            Ok(skipped) => skipped,
            Err(error) => {
                self.discard_watch(prepared);
                return Err(error);
            }
        };
        for run in skipped {
            self.publish(&run);
        }
        self.carry_out(Some(&definition.id));
        match prepared {
            Some(prepared) => self.install_watch(&definition.id, prepared),
            None => self.drop_watch(&definition.id),
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
        self.clear_holds(id);
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

    /// One due job's turn (`service.ts:661`): a GitHub poll is handed to the host, which owns
    /// `gh`; a schedule is admitted here.
    pub fn tick(&mut self) -> Result<Option<Value>> {
        if !self.lives.live() {
            return Ok(None);
        }
        let now = self.now();
        if let Some(job) = self.next_due(now)?
            && job.automation.trigger.kind() == "github"
            && job.due.is_some_and(|due| due <= now)
        {
            let interval = match &job.automation.trigger {
                Trigger::Github {
                    poll_interval_ms, ..
                } => *poll_interval_ms,
                _ => 0,
            };
            self.store
                .advance(&job.automation.id, job.nominal, Some(now + interval))?;
            self.actions.push(Action::PollGithub {
                automation_id: job.automation.id,
            });
            self.arm();
            return Ok(None);
        }
        let generation = self.generation;
        let skip = self.held_ids(now);
        let outcome = self.scheduler().tick_skipping(self.ports.ids, &skip);
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                self.arm();
                return Err(error);
            }
        };
        if let Some(id) = outcome.consumed.clone() {
            self.clear_holds(&id);
        }
        let run = match outcome.run {
            Some(claimed) => {
                if claimed.created {
                    self.publish(&claimed.run);
                }
                if claimed.admitted
                    && self.lives.live()
                    && generation == self.generation
                    && let Some(input) = outcome.input
                    && let Some(run_id) = run_id(&claimed.run)
                {
                    self.pending.insert(run_id.clone());
                    self.actions.push(Action::Execute { run_id, input });
                }
                Some(claimed.run)
            }
            None => None,
        };
        self.arm();
        Ok(run)
    }

    /// The scheduler's timer delay (`service.ts:617`), including a held occurrence's recheck.
    pub fn arm_delay(&mut self) -> Result<Option<i64>> {
        if !self.lives.live() {
            return Ok(None);
        }
        let now = self.now();
        let due = self.next_due(now)?.and_then(|job| job.due);
        let mut delay = due.map(|due| (due - now).clamp(0, MAX_TIMER_DELAY_MS));
        if !self.held.is_empty() {
            let retry = self
                .ports
                .model_retry_ms
                .unwrap_or(MODEL_RETRY_MS)
                .clamp(0, MAX_TIMER_DELAY_MS);
            delay = Some(delay.map_or(retry, |current| current.min(retry)));
        }
        Ok(delay)
    }

    /// Discovery settled (`service.ts:553`): a held occurrence may fire now.
    pub fn models_ready(&mut self) {
        self.arm();
    }

    /// Build every run index in one write. For a file over the idle threshold, the host calls
    /// this from its maintenance window; idle heals smaller files itself.
    pub fn maintenance(&mut self) -> Result<()> {
        self.store.create_run_indexes()
    }

    /// One bounded idle step for the store's migration: examine up to `limit` runs and fill their
    /// finish times from their bodies. Returns how many rows it examined (progress), so the host
    /// loops while it gets a full batch even if those rows needed no update; the store reports
    /// the updates separately. Never history-sized work at open (ADR 0170).
    pub fn idle_step(&mut self, limit: usize) -> Result<usize> {
        self.store.backfill_finished_at(limit)
    }

    /// The host arms its one timer from [`Service::arm_delay`]; this is its re-arm point.
    /// Re-arm the one timer for the earliest of the scheduler's deadline and a failed
    /// interrupt's retry. Arming replaces the previous timer.
    fn arm(&mut self) {
        if !self.lives.live() {
            self.cancel_timer();
            return;
        }
        let now = self.now();
        let mut delay = self.arm_delay().ok().flatten();
        for retry in self.retries.values() {
            let retry_delay = (retry.due - now).clamp(0, crate::scheduler::MAX_TIMER_DELAY_MS);
            delay = Some(delay.map_or(retry_delay, |current| current.min(retry_delay)));
        }
        for finish in self.finishes.values() {
            let retry_delay = (finish.due - now).clamp(0, crate::scheduler::MAX_TIMER_DELAY_MS);
            delay = Some(delay.map_or(retry_delay, |current| current.min(retry_delay)));
        }
        match delay {
            None => self.cancel_timer(),
            Some(delay) => {
                self.cancel_timer();
                match self.ports.timer.arm(delay) {
                    Ok(()) => {
                        self.timer = Some(TimerArm { delay_ms: delay });
                    }
                    Err(error) => self.push_error(error),
                }
            }
        }
    }

    fn cancel_timer(&mut self) {
        if self.timer.take().is_none() {
            return;
        }
        if let Err(error) = self.ports.timer.cancel() {
            self.push_error(error);
        }
    }

    fn push_error(&mut self, message: impl Into<String>) {
        self.errors.push(message.into());
    }

    /// Errors this crate's own work reported (a timer arm or cancel the host refused). The host
    /// logs them, as `Dependencies.onError` does; they are queued so a callback can re-enter the
    /// lifecycle after the method that produced them has returned.
    pub fn take_errors(&mut self) -> Vec<String> {
        std::mem::take(&mut self.errors)
    }

    /// The host's timer fired. A due interrupt retry is handed over again; otherwise the due
    /// schedule takes its turn.
    pub fn timer_fired(&mut self) -> Result<Option<Value>> {
        self.timer = None;
        if !self.lives.live() {
            return Ok(None);
        }
        let now = self.now();
        let finish_due = self
            .finishes
            .iter()
            .filter(|(_, finish)| finish.due <= now)
            .min_by_key(|(_, finish)| finish.due)
            .map(|(run_id, finish)| (run_id.clone(), finish.due));
        let interrupt_due = self
            .retries
            .iter()
            .filter(|(_, retry)| retry.due <= now)
            .min_by_key(|(_, retry)| retry.due)
            .map(|(run_id, retry)| (run_id.clone(), retry.due));
        let target = finish_due
            .map(|(id, due)| (true, id, due))
            .into_iter()
            .chain(interrupt_due.map(|(id, due)| (false, id, due)))
            .min_by_key(|(_, _, due)| *due);
        if let Some((finish, target, _)) = target {
            if finish {
                return self.settle_finish(&target);
            }
            self.retries.remove(&target);
            match self.store.cancelling() {
                Ok(cancelling) => {
                    if let Some((_, input)) = cancelling
                        .into_iter()
                        .find(|(run, _)| run_id(run).as_deref() == Some(target.as_str()))
                    {
                        self.actions.push(Action::Interrupt {
                            run_id: target,
                            input,
                        });
                    } else {
                        self.interrupt_attempts.remove(&target);
                    }
                }
                // A transient lookup failure keeps the retry and its place in the backoff.
                Err(_) => self.schedule_interrupt_retry(&target),
            }
            self.arm();
            return Ok(None);
        }
        self.tick()
    }

    /// The delay this service last armed, for a host that asks before firing.
    pub fn armed_delay(&self) -> Option<i64> {
        self.timer.map(|timer| timer.delay_ms)
    }

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
        // Advance before I/O (`service.ts:710`): a failing poll can never hot-loop.
        self.store.advance(
            id,
            self.store.metadata(id)?.and_then(|job| job.nominal),
            Some(self.now() + poll_interval_ms),
        )?;
        match crate::github::poll_github(client, &trigger, &state) {
            Ok(poll) => {
                if self.store.revision(id)? != revision {
                    return Ok(Vec::new());
                }
                // Admit first and commit the new pages after (`service.ts:725`): a crash between
                // the two re-delivers these events, and their keys deduplicate them.
                let mut runs = Vec::new();
                for event in poll.events {
                    if self.store.revision(id)? != revision {
                        break;
                    }
                    runs.push(self.trigger(id, &event.key, event.variables, "github", None)?);
                }
                if self.store.revision(id)? == revision {
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
                match self.prepare_watch(&definition) {
                    Ok(Some(prepared)) => self.install_watch(id, prepared),
                    Ok(None) => self.drop_watch(id),
                    Err(error) => {
                        let _ = self.save_watch_error(id, &error);
                        return Err(error);
                    }
                }
                // Health clears when this subscription reports readiness, never on subscribe
                // success alone.
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
        // A retry that moves a deadline re-arms the one timer for it.
        self.arm();
        Ok(())
    }
}

fn validate_event(key: &str, variables: &BTreeMap<String, String>) -> Result<()> {
    // The protocol's event key bound counts code points, so 300 emoji (600 UTF-16 units) pass.
    if key.is_empty() || key.chars().count() > 512 {
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
