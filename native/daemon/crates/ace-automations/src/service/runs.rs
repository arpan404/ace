// SPDX-License-Identifier: Apache-2.0
//! The service's run lifecycle (`service.ts`'s admission and `execution-owner.ts`): one run's
//! claim and start, the executor's completion (immediate or deferred until the host has acted on
//! the notification), a refused terminal write kept for its timer retry, recovery that finds
//! nothing to follow, interrupt backoff, and starting waiting runs as room frees.

use std::collections::BTreeMap;

use ace_json::{Map, Value};

use super::{Action, Finish, Retry, Service, manual_id, run_automation, run_id, validate_event};
use crate::decisions::{
    PAUSED_REFUSAL, PAUSED_RESULT, render_prompt, run_access, with_run_note, with_webhook_note,
};
use crate::error::{AutomationsError, Result};
use crate::store::{Claim, Definition};

impl<'a> Service<'a> {
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
        // Admission, its webhook receipt and pruning commit together, so a retried delivery
        // either finds both or neither.
        let (claimed, input) = self
            .store
            .transaction(|| self.admit(&definition, key, &variables, kind, note))?;
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
            self.ports.ids.next_id()
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

    /// Another attempt at a settled run's terminal write, with the outcome the executor gave.
    pub(super) fn settle_finish(&mut self, run_id: &str) -> Result<Option<Value>> {
        let Some(finish) = self.finishes.get(run_id).cloned() else {
            self.arm();
            return Ok(None);
        };
        let finished = self.store.finish(
            run_id,
            self.now(),
            &finish.status,
            finish.thread_id.as_deref(),
            finish.result.as_deref(),
        );
        match finished {
            Ok(finished) => {
                self.pending.remove(run_id);
                self.finishes.remove(run_id);
                self.retries.remove(run_id);
                self.interrupt_attempts.remove(run_id);
                if let Some(run) = &finished {
                    self.publish(run);
                }
                self.drain_waiting();
                self.arm();
                Ok(finished)
            }
            Err(error) => {
                // The run keeps its slot and its exact outcome until the write is accepted.
                let due = self.now() + 1000;
                if let Some(finish) = self.finishes.get_mut(run_id) {
                    finish.due = due;
                }
                self.push_error(error.to_string());
                self.arm();
                Ok(None)
            }
        }
    }

    /// The executor refused an interrupt (`cancellations.ts:47`). While the cancellation stands,
    /// try again with the TypeScript's backoff, capped at a minute.
    pub fn interrupt_failed(&mut self, run_id: &str, message: &str) {
        if !self.lives.live() || self.store.cancellation(run_id).ok().flatten().is_none() {
            return;
        }
        self.schedule_interrupt_retry(run_id);
        self.push_error(message);
        self.arm();
    }

    /// The TypeScript's backoff (`cancellations.ts:47`), capped at a minute, counted over every
    /// attempt rather than restarting at each hand-off.
    pub(super) fn schedule_interrupt_retry(&mut self, run_id: &str) {
        let attempt = self.interrupt_attempts.get(run_id).copied().unwrap_or(0);
        let delay = 1000i64
            .saturating_mul(2i64.saturating_pow(attempt.min(6)))
            .min(60_000);
        self.interrupt_attempts
            .insert(run_id.to_owned(), attempt.saturating_add(1));
        self.retries.insert(
            run_id.to_owned(),
            Retry {
                due: self.now() + delay,
            },
        );
    }

    /// A run's executor settled (`execution-owner.ts:122`).
    pub fn complete(
        &mut self,
        run_id: &str,
        status: &str,
        thread_id: Option<&str>,
        result: Option<&str>,
    ) -> Result<Option<Value>> {
        let finished = self.finish_run(run_id, status, thread_id, result)?;
        self.drain_waiting();
        Ok(finished)
    }

    /// Settle a run and publish it, but leave waiting runs for the host to start after it has
    /// acted on the notification. This is the boundary the TypeScript's synchronous `onRun`
    /// callback has: a host can trigger another automation in the room the finished run left
    /// before the automation's own waiting run is promoted.
    pub fn complete_deferred(
        &mut self,
        run_id: &str,
        status: &str,
        thread_id: Option<&str>,
        result: Option<&str>,
    ) -> Result<Option<Value>> {
        self.finish_run(run_id, status, thread_id, result)
    }

    fn finish_run(
        &mut self,
        run_id: &str,
        status: &str,
        thread_id: Option<&str>,
        result: Option<&str>,
    ) -> Result<Option<Value>> {
        if !self.lives.live() || !self.pending.contains(run_id) {
            return Ok(None);
        }
        let finished = self
            .store
            .finish(run_id, self.now(), status, thread_id, result);
        match finished {
            Ok(finished) => {
                self.pending.remove(run_id);
                self.finishes.remove(run_id);
                self.retries.remove(run_id);
                self.interrupt_attempts.remove(run_id);
                if let Some(run) = &finished {
                    self.publish(run);
                }
                self.arm();
                Ok(finished)
            }
            Err(error) => {
                // A transient terminal-write failure must not strand the run: keep its outcome
                // and ownership, and let the timer commit it again.
                self.finishes.insert(
                    run_id.to_owned(),
                    Finish {
                        status: status.to_owned(),
                        thread_id: thread_id.map(str::to_owned),
                        result: result.map(str::to_owned),
                        due: self.now() + 1000,
                    },
                );
                self.push_error(error.to_string());
                self.arm();
                Ok(None)
            }
        }
    }

    /// Recovery found nothing to follow (`execution-owner.ts:69`): send the stored input once.
    pub fn recovery_empty(&mut self, run_id: &str) -> Result<()> {
        if !self.lives.live() || !self.pending.contains(run_id) {
            return Ok(());
        }
        if self.store.cancellation(run_id)?.is_some() {
            // The same completion path an executor's failure takes: a refused terminal write
            // keeps the run's ownership and this outcome for the timer's retry, and a committed
            // one publishes the finish and starts what waited behind it.
            self.complete(run_id, "failed", None, Some("Stopped before it started."))?;
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
}
