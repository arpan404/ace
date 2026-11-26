// SPDX-License-Identifier: Apache-2.0
//! The scheduler state machine, ported from `AutomationService`'s scheduling half
//! (`packages/automations/src/service.ts`): one timer on the earliest due schedule, the
//! missed-run decision at startup and on a late tick, jittered deadlines that never overtake
//! the next nominal occurrence, and occurrence cursors persisted with the definition.
//!
//! Sans-IO: the clock, the random draw and ids are injected ports; no code here reads
//! `Instant`, `SystemTime` or a global RNG.

use std::collections::BTreeMap;

use ace_json::{Map, Value};

use crate::decisions::{PAUSED_RESULT, render_prompt, run_access, scheduled_deadline};
use crate::error::{AutomationsError, Result};
use crate::recurrence::{Occurrence, Recurrence};
use crate::store::{AutomationStore, Claim, ClaimedRun, Definition, JobMetadata};

/// How late a scheduled fire can be and still count as on time. Later than this, the computer
/// slept or ace wasn't running through it, and "If missed: Skip" skips it.
pub const LATE_GRACE_MS: i64 = 2 * 60_000;
/// The longest a timer waits before looking again, even for a far deadline.
pub const MAX_TIMER_DELAY_MS: i64 = 60_000;

pub trait Clock {
    fn now_ms(&self) -> i64;
}

#[derive(Debug, Clone, Copy)]
pub struct FixedClock(pub i64);

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

pub trait Random {
    /// A draw in `[0, 1)`, as `Math.random` returns.
    fn draw(&self) -> f64;
}

#[derive(Debug, Clone, Copy)]
pub struct FixedRandom(pub f64);

impl Random for FixedRandom {
    fn draw(&self) -> f64 {
        self.0
    }
}

pub trait IdSource {
    fn next_id(&mut self) -> String;
}

/// Deterministic ids for tests and for a host that already owns an id generator.
pub struct CounterIds {
    prefix: String,
    next: u64,
}

impl CounterIds {
    pub fn new(prefix: impl Into<String>) -> CounterIds {
        CounterIds::with_start(prefix, 0)
    }

    pub fn with_start(prefix: impl Into<String>, next: u64) -> CounterIds {
        CounterIds {
            prefix: prefix.into(),
            next,
        }
    }
}

impl IdSource for CounterIds {
    fn next_id(&mut self) -> String {
        self.next += 1;
        format!("{}-{}", self.prefix, self.next)
    }
}

/// Admission for new work (the person's pause, an update's drain).
pub trait Admission {
    fn open(&self) -> bool;
    /// Why admission is closed when the reason isn't a pause.
    fn closed_reason(&self) -> Option<String> {
        None
    }
}

/// Admission that is always open, as a daemon without a gate behaves.
pub struct OpenAdmission;

impl Admission for OpenAdmission {
    fn open(&self) -> bool {
        true
    }
}

#[derive(Debug, Default)]
pub struct StartOutcome {
    /// The earliest readable due deadline after recovery.
    pub deadline: Option<i64>,
    /// Errors from records this build could not schedule; each was isolated and kept.
    pub errors: Vec<String>,
}

#[derive(Debug, Default)]
pub struct TickOutcome {
    /// The run this tick admitted or skipped, when one was claimed.
    pub run: Option<ClaimedRun>,
    /// The execution input stored with that run, when it rendered.
    pub input: Option<Value>,
    /// The next deadline after the tick (the timer re-arms for it).
    pub deadline: Option<i64>,
}

pub struct Scheduler<'a> {
    store: &'a AutomationStore,
    clock: &'a dyn Clock,
    random: &'a dyn Random,
    admission: &'a dyn Admission,
}

impl<'a> Scheduler<'a> {
    pub fn new(
        store: &'a AutomationStore,
        clock: &'a dyn Clock,
        random: &'a dyn Random,
        admission: &'a dyn Admission,
    ) -> Scheduler<'a> {
        Scheduler {
            store,
            clock,
            random,
            admission,
        }
    }

    fn recurrence(automation: &Definition) -> Result<Option<Recurrence>> {
        automation
            .schedule()
            .map(|schedule| Recurrence::compile(schedule.clone()))
            .transpose()
    }

    fn cursor(&self, id: &str) -> Result<Occurrence> {
        let state = self.store.read_state(id)?;
        ace_json::from_value(&state)
            .map_err(|_| AutomationsError::message("Invalid counted cursor"))
    }

    fn isolate(&self, job: &JobMetadata, now: i64, error: &AutomationsError) -> String {
        let message = error.to_string();
        let mut failure = Map::new();
        failure.insert("message", Value::String(message.as_str().into()));
        failure.insert("at", Value::Number(now.into()));
        let _ = self
            .store
            .save_trigger_error(&job.automation.id, &Value::Object(failure));
        let _ = self.store.advance(&job.automation.id, job.nominal, None);
        message
    }

    /// Start-up recovery (`service.ts:283`): a schedule whose occurrence passed while ace was
    /// off keeps it for `run_once` and advances past it for `skip`, then the store's cursor and
    /// deadline are what both daemons read.
    pub fn start(&self) -> Result<StartOutcome> {
        let now = self.clock.now_ms();
        let mut outcome = StartOutcome::default();
        let jobs = self.store.jobs(|id, error| {
            outcome.errors.push(format!("{id}: {error}"));
        })?;
        for job in jobs {
            if job.automation.schedule().is_none() {
                continue;
            }
            let (Some(nominal), Some(due)) = (job.nominal, job.due) else {
                continue;
            };
            let recovered = (|| -> Result<()> {
                let recurrence = Self::recurrence(&job.automation)?
                    .ok_or_else(|| AutomationsError::message("Missing recurrence"))?;
                let current = self.cursor(&job.automation.id)?;
                let occurrence = crate::decisions::recover_occurrence(
                    &recurrence,
                    current,
                    due,
                    now,
                    job.automation.missed_run_skips(),
                )?;
                if occurrence.map(|occurrence| occurrence.at) != Some(nominal) {
                    let deadline = scheduled_deadline(
                        occurrence,
                        &recurrence,
                        job.automation.jitter_ms,
                        self.random.draw(),
                    )?;
                    self.store.transaction(|| {
                        self.store.advance(
                            &job.automation.id,
                            occurrence.map(|occurrence| occurrence.at),
                            deadline,
                        )?;
                        self.store
                            .save_poll(&job.automation.id, &occurrence_value(occurrence))
                    })?;
                }
                Ok(())
            })();
            if let Err(error) = recovered {
                outcome.errors.push(self.isolate(&job, now, &error));
            }
        }
        outcome.deadline = self.store.next_scheduled()?.and_then(|job| job.due);
        Ok(outcome)
    }

    /// The one timer's delay (`service.ts:617`): the earliest due schedule, capped at a minute.
    pub fn arm_delay(&self) -> Result<Option<i64>> {
        let Some(job) = self.store.next_scheduled()? else {
            return Ok(None);
        };
        let Some(due) = job.due else {
            return Ok(None);
        };
        Ok(Some(
            (due - self.clock.now_ms()).clamp(0, MAX_TIMER_DELAY_MS),
        ))
    }

    /// One due schedule's turn (`service.ts:661`): a late fire with the skip policy moves on
    /// without a run; otherwise the due occurrence is admitted under the current admission gate
    /// and the next one is persisted with its jittered deadline.
    pub fn tick(&self, ids: &mut dyn IdSource) -> Result<TickOutcome> {
        let now = self.clock.now_ms();
        let Some(job) = self.store.next_scheduled()? else {
            return Ok(TickOutcome::default());
        };
        if job.due.is_none_or(|due| due > now) {
            return Ok(TickOutcome {
                run: None,
                input: None,
                deadline: job.due,
            });
        }
        let Some(nominal) = job.nominal else {
            let error = AutomationsError::message("Invalid scheduled job");
            self.isolate(&job, now, &error);
            return Ok(TickOutcome {
                run: None,
                input: None,
                deadline: self.store.next_scheduled()?.and_then(|job| job.due),
            });
        };
        let recurrence = match Self::recurrence(&job.automation) {
            Ok(Some(recurrence)) => recurrence,
            Ok(None) => {
                let error = AutomationsError::message("Invalid scheduled job");
                self.isolate(&job, now, &error);
                return Ok(TickOutcome {
                    run: None,
                    input: None,
                    deadline: self.store.next_scheduled()?.and_then(|job| job.due),
                });
            }
            Err(error) => {
                self.isolate(&job, now, &error);
                return Ok(TickOutcome {
                    run: None,
                    input: None,
                    deadline: self.store.next_scheduled()?.and_then(|job| job.due),
                });
            }
        };
        let occurrence = match self
            .cursor(&job.automation.id)
            .and_then(|cursor| recurrence.seek(nominal.max(now), Some(cursor)))
        {
            Ok(occurrence) => occurrence,
            Err(error) => {
                self.isolate(&job, now, &error);
                return Ok(TickOutcome {
                    run: None,
                    input: None,
                    deadline: self.store.next_scheduled()?.and_then(|job| job.due),
                });
            }
        };
        let deadline = scheduled_deadline(
            occurrence,
            &recurrence,
            job.automation.jitter_ms,
            self.random.draw(),
        )?;
        let late = job.automation.missed_run_skips()
            && job.due.is_some_and(|due| now - due > LATE_GRACE_MS);
        if late {
            self.store.transaction(|| {
                self.store.advance(
                    &job.automation.id,
                    occurrence.map(|occurrence| occurrence.at),
                    deadline,
                )?;
                self.store
                    .save_poll(&job.automation.id, &occurrence_value(occurrence))
            })?;
            return Ok(TickOutcome {
                run: None,
                input: None,
                deadline: self.store.next_scheduled()?.and_then(|job| job.due),
            });
        }
        let run_id = ids.next_id();
        let event_key = format!("schedule:{nominal}");
        let mut variables = BTreeMap::new();
        variables.insert(
            "scheduled_at".to_owned(),
            crate::calendar::iso_string(nominal),
        );
        let input = self.execution_input(&job.automation, &run_id, &variables, now);
        let (input, failure) = match input {
            Ok(input) => (Some(input), None),
            Err(error) => (None, Some(error.to_string())),
        };
        let skip = if self.admission.open() {
            None
        } else {
            Some(
                self.admission
                    .closed_reason()
                    .unwrap_or_else(|| PAUSED_RESULT.to_owned()),
            )
        };
        let claimed = self.store.transaction(|| {
            let claimed = self.store.claim(
                &job.automation,
                &Claim {
                    event_key: &event_key,
                    trigger: "schedule",
                    id: &run_id,
                    now,
                    input: input.as_ref(),
                    failure: failure.as_deref(),
                    skip: skip.as_deref(),
                },
            )?;
            self.store.advance(
                &job.automation.id,
                occurrence.map(|occurrence| occurrence.at),
                deadline,
            )?;
            self.store
                .save_poll(&job.automation.id, &occurrence_value(occurrence))?;
            Ok(claimed)
        })?;
        Ok(TickOutcome {
            run: Some(claimed),
            input,
            deadline: self.store.next_scheduled()?.and_then(|job| job.due),
        })
    }

    fn execution_input(
        &self,
        automation: &Definition,
        run_id: &str,
        variables: &BTreeMap<String, String>,
        _now: i64,
    ) -> Result<Value> {
        let prompt = render_prompt(&automation.prompt, variables)?;
        let mut input = Map::new();
        input.insert("idempotencyKey", Value::String(run_id.into()));
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
        let webhook = automation.trigger.kind() == "webhook";
        if let Some(access) = run_access(automation.access.as_deref(), webhook) {
            input.insert("access", Value::String(access.as_str().into()));
            if webhook {
                input.insert("accessCeiling", Value::String(access.as_str().into()));
            }
        }
        Ok(Value::Object(input))
    }

    /// `put` without the runtime subscriptions (`service.ts:313`): the occurrence and its
    /// jittered deadline commit with the definition, and an unchanged save keeps both.
    pub fn put(
        &self,
        automation: &Definition,
        expected_revision: Option<Option<i64>>,
    ) -> Result<()> {
        let now = self.clock.now_ms();
        let existing = self.store.definition(&automation.id)?;
        if expected_revision == Some(None) && existing.is_some() {
            return Err(AutomationsError::message("Automation already exists"));
        }
        if let Some(Some(expected)) = expected_revision {
            if existing.is_none() {
                return Err(AutomationsError::message("Automation is missing"));
            }
            if self.store.revision(&automation.id)? != Some(expected) {
                return Err(AutomationsError::message("Automation revision conflict"));
            }
        }
        if existing.as_ref() == Some(automation) {
            return Ok(());
        }
        let recurrence = Self::recurrence(automation)?;
        let occurrence = if automation.enabled {
            recurrence
                .as_ref()
                .map(|recurrence| recurrence.seek(now - 1, None))
                .transpose()?
                .flatten()
        } else {
            None
        };
        let nominal = occurrence.map(|occurrence| occurrence.at);
        let due = if !automation.enabled {
            None
        } else if automation.trigger.kind() == "github" {
            Some(now)
        } else {
            match &recurrence {
                Some(recurrence) => scheduled_deadline(
                    occurrence,
                    recurrence,
                    automation.jitter_ms,
                    self.random.draw(),
                )?,
                None => None,
            }
        };
        self.store.put(
            automation,
            nominal,
            due,
            &occurrence_value(occurrence),
            expected_revision,
        )?;
        Ok(())
    }

    pub fn remove(&self, id: &str, expected_revision: Option<Option<i64>>) -> Result<Vec<Value>> {
        self.store.transaction(|| {
            self.store.remove(id, expected_revision)?;
            self.store
                .halt(id, self.clock.now_ms(), "Deleted before it started")
        })
    }

    pub fn set_enabled(
        &self,
        id: &str,
        enabled: bool,
        expected_revision: Option<i64>,
    ) -> Result<()> {
        let Some(mut current) = self.store.definition(id)? else {
            return Err(AutomationsError::message("Automation is missing"));
        };
        current.enabled = enabled;
        self.put(&current, expected_revision.map(Some))
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

    /// `triggerReadiness`: the next run's time as `automation.list` exposes it.
    pub fn next_run_at(&self, id: &str) -> Result<Option<i64>> {
        Ok(self.store.metadata(id)?.and_then(|job| job.due))
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

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::path::Path;

    use ace_store::{Connection, OpenOptions};

    use super::*;
    use crate::recurrence::{Schedule, ScheduleKind};
    use crate::store::Trigger;

    const START: i64 = 1_704_099_600_000; // 2024-01-01T09:00:00Z
    const DAY: i64 = 86_400_000;

    struct TestClock(Cell<i64>);

    impl Clock for TestClock {
        fn now_ms(&self) -> i64 {
            self.0.get()
        }
    }

    struct TestRandom(Cell<f64>);

    impl Random for TestRandom {
        fn draw(&self) -> f64 {
            self.0.get()
        }
    }

    struct TestAdmission {
        open: Cell<bool>,
        reason: Option<String>,
    }

    impl Admission for TestAdmission {
        fn open(&self) -> bool {
            self.open.get()
        }

        fn closed_reason(&self) -> Option<String> {
            self.reason.clone()
        }
    }

    struct Harness {
        dir: tempfile::TempDir,
        store: AutomationStore,
        clock: TestClock,
        random: TestRandom,
        admission: TestAdmission,
    }

    impl Harness {
        fn new() -> Harness {
            let dir = tempfile::tempdir().expect("temp dir");
            let store =
                AutomationStore::open(dir.path().join("auto.sqlite").to_str().expect("utf8"))
                    .expect("store opens");
            Harness {
                dir,
                store,
                clock: TestClock(Cell::new(START - 60_000)),
                random: TestRandom(Cell::new(0.0)),
                admission: TestAdmission {
                    open: Cell::new(true),
                    reason: None,
                },
            }
        }

        fn path(&self) -> &Path {
            self.dir.path()
        }

        fn scheduler(&self) -> Scheduler<'_> {
            Scheduler::new(&self.store, &self.clock, &self.random, &self.admission)
        }

        fn put(&self, definition: &Definition) {
            self.scheduler().put(definition, None).expect("put");
        }
    }

    fn definition() -> Definition {
        Definition {
            id: "triage".to_owned(),
            title: "Triage".to_owned(),
            enabled: true,
            workspace: "/project".to_owned(),
            provider: "codex".to_owned(),
            access: None,
            model: Some("test-model".to_owned()),
            effort: None,
            instance: None,
            prompt: "Triage {{subject}}".to_owned(),
            worktree: true,
            trigger: Trigger::Manual,
            missed_run: "skip".to_owned(),
            concurrency: 1,
            jitter_ms: 0,
        }
    }

    fn scheduled(policy: &str, jitter_ms: i64) -> Definition {
        Definition {
            prompt: "Triage {{scheduled_at}}".to_owned(),
            trigger: Trigger::Schedule {
                schedule: Schedule {
                    kind: ScheduleKind::Rrule,
                    expression: "FREQ=DAILY".to_owned(),
                    timezone: "UTC".to_owned(),
                    start_at: START,
                },
            },
            missed_run: policy.to_owned(),
            jitter_ms,
            ..definition()
        }
    }

    fn prompt(outcome: &TickOutcome) -> Option<String> {
        let input = outcome.input.as_ref()?.as_object()?;
        input.get("prompt")?.as_str().map(str::to_owned)
    }

    fn event_key(outcome: &TickOutcome) -> Option<String> {
        let run = outcome.run.as_ref()?.run.as_object()?;
        run.get("eventKey")?.as_str().map(str::to_owned)
    }

    fn run_status(outcome: &TickOutcome) -> Option<String> {
        let run = outcome.run.as_ref()?.run.as_object()?;
        run.get("status")?.as_str().map(str::to_owned)
    }

    fn run_result(outcome: &TickOutcome) -> Option<String> {
        let run = outcome.run.as_ref()?.run.as_object()?;
        run.get("result")?.as_str().map(str::to_owned)
    }

    #[test]
    fn startup_advances_a_skipped_occurrence_and_arms_a_minute() {
        let h = Harness::new();
        h.put(&scheduled("skip", 0));
        let before = h.store.get("triage").expect("get").expect("job");
        assert_eq!(
            (before.metadata.nominal, before.metadata.due),
            (Some(START), Some(START))
        );
        h.clock.0.set(START + 3 * DAY);
        let started = h.scheduler().start().expect("start");
        assert!(started.errors.is_empty());
        let job = h.store.get("triage").expect("get").expect("job");
        assert_eq!(
            (job.metadata.nominal, job.metadata.due),
            (Some(START + 4 * DAY), Some(START + 4 * DAY))
        );
        assert_eq!(h.scheduler().arm_delay().expect("delay"), Some(60_000));
        assert!(
            h.store
                .list()
                .expect("list")
                .iter()
                .all(|job| job.trigger_error.is_none())
        );
    }

    #[test]
    fn a_schedule_set_to_skip_missed_runs_skips_one_the_computer_slept_through() {
        let h = Harness::new();
        h.put(&scheduled("skip", 0));
        h.clock.0.set(START + 3 * 3_600_000);
        let mut ids = CounterIds::new("run");
        let skipped = h.scheduler().tick(&mut ids).expect("tick");
        assert!(skipped.run.is_none());
        assert!(!h.store.running("triage").expect("running"));
        assert_eq!(h.store.run_count().expect("count"), 0);
        h.clock.0.set(START + DAY);
        let next = h.scheduler().tick(&mut ids).expect("tick");
        assert_eq!(
            prompt(&next),
            Some(format!(
                "Triage {}",
                crate::calendar::iso_string(START + DAY)
            ))
        );
        assert_eq!(run_status(&next).as_deref(), Some("running"));
    }

    #[test]
    fn a_schedule_set_to_run_missed_runs_once_runs_the_one_it_slept_through_once() {
        let h = Harness::new();
        h.put(&scheduled("run_once", 0));
        h.clock.0.set(START + 3 * 3_600_000);
        let mut ids = CounterIds::new("run");
        let first = h.scheduler().tick(&mut ids).expect("tick");
        assert_eq!(
            prompt(&first),
            Some(format!("Triage {}", crate::calendar::iso_string(START)))
        );
        let second = h.scheduler().tick(&mut ids).expect("tick");
        assert!(second.run.is_none());
    }

    #[test]
    fn a_run_that_is_only_a_little_late_is_still_on_time() {
        let h = Harness::new();
        h.put(&scheduled("skip", 0));
        h.clock.0.set(START + 30_000);
        let mut ids = CounterIds::new("run");
        let run = h.scheduler().tick(&mut ids).expect("tick");
        assert_eq!(
            prompt(&run),
            Some(format!("Triage {}", crate::calendar::iso_string(START)))
        );
    }

    #[test]
    fn a_schedule_due_while_new_work_is_paused_is_skipped_then_runs_at_its_next_time() {
        let h = Harness::new();
        h.put(&scheduled("skip", 0));
        h.admission.open.set(false);
        h.clock.0.set(START);
        let mut ids = CounterIds::new("run");
        let skipped = h.scheduler().tick(&mut ids).expect("tick");
        assert_eq!(run_status(&skipped).as_deref(), Some("skipped"));
        assert_eq!(run_result(&skipped).as_deref(), Some(PAUSED_RESULT));
        assert_eq!(
            h.scheduler().next_run_at("triage").expect("next"),
            Some(START + DAY)
        );
        h.admission.open.set(true);
        h.clock.0.set(START + DAY);
        let run = h.scheduler().tick(&mut ids).expect("tick");
        assert_eq!(
            prompt(&run),
            Some("Triage 2024-01-02T09:00:00.000Z".to_owned())
        );
        assert_eq!(run_status(&run).as_deref(), Some("running"));
    }

    #[test]
    fn large_jitter_cannot_skip_later_nominal_occurrences() {
        let h = Harness::new();
        h.random.0.set(0.99);
        let mut auto = scheduled("run_once", 600_000);
        if let Trigger::Schedule { schedule } = &mut auto.trigger {
            schedule.expression = "FREQ=MINUTELY;COUNT=3".to_owned();
        }
        h.put(&auto);
        assert_eq!(h.scheduler().arm_delay().expect("delay"), Some(60_000));
        h.clock.0.set(START + 59_400);
        let mut ids = CounterIds::new("run");
        let first = h.scheduler().tick(&mut ids).expect("tick");
        assert_eq!(event_key(&first), Some(format!("schedule:{START}")));
        assert_eq!(
            prompt(&first),
            Some("Triage 2024-01-01T09:00:00.000Z".to_owned())
        );
        assert_eq!(h.scheduler().arm_delay().expect("delay"), Some(60_000));
        h.clock.0.set(START + 119_400);
        let second = h.scheduler().tick(&mut ids).expect("tick");
        assert_eq!(
            event_key(&second),
            Some(format!("schedule:{}", START + 60_000))
        );
        assert_eq!(
            prompt(&second),
            Some("Triage 2024-01-01T09:01:00.000Z".to_owned())
        );
    }

    #[test]
    fn an_identical_put_retains_a_pending_jittered_occurrence_across_restart() {
        let h = Harness::new();
        h.random.0.set(0.5);
        let mut auto = scheduled("run_once", 10_000);
        auto.access = Some("read-only".to_owned());
        if let Trigger::Schedule { schedule } = &mut auto.trigger {
            schedule.expression = "FREQ=DAILY;COUNT=2".to_owned();
        }
        h.put(&auto);
        h.clock.0.set(START + 1000);
        h.random.0.set(0.9);
        h.scheduler().put(&auto, None).expect("identical put");
        // Restart: a fresh store on the same file, as the daemon opens it again.
        let reopened = AutomationStore::open(h.path().join("auto.sqlite").to_str().expect("utf8"))
            .expect("reopen");
        {
            let scheduler = Scheduler::new(&reopened, &h.clock, &h.random, &h.admission);
            scheduler.put(&auto, None).expect("identical put");
            h.clock.0.set(START + 5000);
            let mut ids = CounterIds::new("run");
            let first = scheduler.tick(&mut ids).expect("tick");
            let input = first
                .input
                .expect("input")
                .as_object()
                .cloned()
                .unwrap_or_default();
            assert_eq!(
                input.get("prompt").and_then(|value| value.as_str()),
                Some("Triage 2024-01-01T09:00:00.000Z")
            );
            assert_eq!(
                input.get("access").and_then(|value| value.as_str()),
                Some("read-only")
            );
            h.clock.0.set(START + DAY + 9000);
            let second = scheduler.tick(&mut ids).expect("tick");
            assert_eq!(
                prompt(&second),
                Some("Triage 2024-01-02T09:00:00.000Z".to_owned())
            );
        }
        reopened.close().expect("close");
    }

    #[test]
    fn create_only_puts_fail_while_the_id_is_live_and_succeed_after_removal() {
        let h = Harness::new();
        h.put(&definition());
        let error = h
            .scheduler()
            .put(&definition(), Some(None))
            .expect_err("live");
        assert_eq!(error.to_string(), "Automation already exists");
        let removed = h.scheduler().remove("triage", None).expect("remove");
        assert!(removed.is_empty());
        h.scheduler()
            .put(&definition(), Some(None))
            .expect("recreate");
        assert_eq!(h.scheduler().list().expect("list").len(), 1);
    }

    #[test]
    fn a_stale_revision_cannot_resurrect_a_removed_id_while_blind_writes_can() {
        let h = Harness::new();
        h.put(&definition());
        assert_eq!(h.store.revision("triage").expect("revision"), Some(1));
        h.scheduler().remove("triage", None).expect("remove");
        assert_eq!(h.store.revision("triage").expect("revision"), Some(2));
        let error = h
            .scheduler()
            .put(&definition(), Some(Some(1)))
            .expect_err("stale");
        assert_eq!(error.to_string(), "Automation is missing");
        h.put(&definition());
        assert_eq!(h.store.revision("triage").expect("revision"), Some(3));
    }

    #[test]
    fn matching_revisions_update_and_bump_while_stale_ones_change_nothing() {
        let h = Harness::new();
        h.put(&definition());
        let mut second = definition();
        second.title = "Second".to_owned();
        h.scheduler().put(&second, Some(Some(1))).expect("second");
        assert_eq!(h.store.revision("triage").expect("revision"), Some(2));
        let mut stale = definition();
        stale.title = "Stale".to_owned();
        let error = h.scheduler().put(&stale, Some(Some(1))).expect_err("stale");
        assert_eq!(error.to_string(), "Automation revision conflict");
        assert_eq!(h.scheduler().list().expect("list")[0].title, "Second");
    }

    #[test]
    fn identical_puts_with_a_matching_revision_stay_idempotent_without_bumping() {
        let h = Harness::new();
        let auto = scheduled("run_once", 10_000);
        h.random.0.set(0.5);
        h.put(&auto);
        h.random.0.set(0.9);
        h.scheduler().put(&auto, Some(Some(1))).expect("identical");
        assert_eq!(h.store.revision("triage").expect("revision"), Some(1));
        assert_eq!(
            h.store
                .metadata("triage")
                .expect("metadata")
                .and_then(|job| job.due),
            Some(START + 5000)
        );
    }

    #[test]
    fn set_enabled_flips_the_definition_and_honors_cas() {
        let h = Harness::new();
        h.put(&definition());
        let error = h
            .scheduler()
            .set_enabled("triage", false, Some(0))
            .expect_err("stale");
        assert_eq!(error.to_string(), "Automation revision conflict");
        h.scheduler()
            .set_enabled("triage", false, Some(1))
            .expect("disable");
        assert!(!h.scheduler().list().expect("list")[0].enabled);
        assert_eq!(h.store.revision("triage").expect("revision"), Some(2));
    }

    #[test]
    fn catalog_is_scoped_and_follows_saves_disables_and_deletions() {
        let h = Harness::new();
        h.put(&definition());
        let mut other_provider = definition();
        other_provider.id = "other-provider".to_owned();
        other_provider.provider = "claude".to_owned();
        h.put(&other_provider);
        let mut other_workspace = definition();
        other_workspace.id = "other-workspace".to_owned();
        other_workspace.workspace = "/elsewhere".to_owned();
        h.put(&other_workspace);
        let mut disabled = definition();
        disabled.id = "disabled".to_owned();
        disabled.enabled = false;
        h.put(&disabled);
        assert_eq!(
            h.scheduler().catalog("codex", "/project").expect("catalog"),
            vec![("triage".to_owned(), "Triage".to_owned())]
        );
        let mut renamed = definition();
        renamed.title = "Renamed".to_owned();
        h.put(&renamed);
        assert_eq!(
            h.scheduler().catalog("codex", "/project").expect("catalog"),
            vec![("triage".to_owned(), "Renamed".to_owned())]
        );
        let mut off = renamed.clone();
        off.enabled = false;
        h.put(&off);
        assert!(
            h.scheduler()
                .catalog("codex", "/project")
                .expect("catalog")
                .is_empty()
        );
        h.put(&renamed);
        h.scheduler().remove("triage", None).expect("remove");
        assert!(
            h.scheduler()
                .catalog("codex", "/project")
                .expect("catalog")
                .is_empty()
        );
    }

    #[test]
    fn legacy_inline_cursors_survive_migration_and_subsequent_restarts() {
        let h = Harness::new();
        h.put(&definition());
        let path = h.path().join("auto.sqlite");
        let raw = Connection::open(
            path.to_str().expect("utf8"),
            OpenOptions {
                read_only: false,
                timeout_ms: 5000,
            },
        )
        .expect("raw open");
        raw.exec("DROP TABLE automation_state").expect("drop");
        raw.exec(
      "UPDATE automation_jobs SET state='{\"pages\":[{\"endpoint\":\"repos/user/project/issues\",\"etag\":\"\\\"legacy\\\"\",\"entries\":[]}]}' WHERE id='triage'",
    )
    .expect("legacy state");
        raw.close().expect("raw close");
        let restored = AutomationStore::open(path.to_str().expect("utf8")).expect("reopen");
        let expected = ace_json::parse(
      "{\"pages\":[{\"endpoint\":\"repos/user/project/issues\",\"etag\":\"\\\"legacy\\\"\",\"entries\":[]}]}",
    )
    .expect("json");
        assert_eq!(restored.read_state("triage").expect("state"), expected);
        restored
            .save_poll("triage", &ace_json::parse("{\"pages\":[]}").expect("json"))
            .expect("save");
        restored.close().expect("close");
        let second = AutomationStore::open(path.to_str().expect("utf8")).expect("reopen");
        assert_eq!(
            second.read_state("triage").expect("state"),
            ace_json::parse("{\"pages\":[]}").expect("json")
        );
        second.close().expect("close");
    }

    #[test]
    fn an_unreadable_automation_with_the_earliest_deadline_never_keeps_the_next_one_from_its_timer()
    {
        let h = Harness::new();
        let mut kept = scheduled("skip", 0);
        kept.id = "kept".to_owned();
        h.put(&kept);
        let mut newer = scheduled("skip", 0);
        newer.id = "newer".to_owned();
        h.put(&newer);
        let path = h.path().join("auto.sqlite");
        let raw = Connection::open(
            path.to_str().expect("utf8"),
            OpenOptions {
                read_only: false,
                timeout_ms: 5000,
            },
        )
        .expect("raw open");
        raw.exec(
      "UPDATE automation_jobs SET body=json_set(body,'$.trigger',json('{\"kind\":\"lunar\"}')),due=due-60000 WHERE id='newer'",
    )
    .expect("future trigger");
        raw.close().expect("raw close");
        let reopened = AutomationStore::open(path.to_str().expect("utf8")).expect("reopen");
        {
            let scheduler = Scheduler::new(&reopened, &h.clock, &h.random, &h.admission);
            let started = scheduler.start().expect("start");
            assert_eq!(started.errors.len(), 1);
            assert!(started.errors[0].contains("newer"));
            assert_eq!(scheduler.arm_delay().expect("delay"), Some(60_000));
            h.clock.0.set(START);
            let mut ids = CounterIds::new("run");
            let run = scheduler.tick(&mut ids).expect("tick");
            assert_eq!(
                prompt(&run),
                Some("Triage 2024-01-01T09:00:00.000Z".to_owned())
            );
        }
        reopened.close().expect("close");
    }
}
