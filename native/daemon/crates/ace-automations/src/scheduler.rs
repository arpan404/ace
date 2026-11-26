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

pub trait IdSource: Send {
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
