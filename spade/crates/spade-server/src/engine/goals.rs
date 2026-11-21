//! A task's goal, plan and the check of done in the engine (ADR 0159). The rules are
//! `spade_core::goal`; this answers `task_goal` and `task_plan` calls, runs the verifier when a
//! claim of done needs one, and gives the person's goal edits and the task view to the API.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use spade_core::Event;
use spade_core::event::Known;
use spade_core::goal::change::{self, Accepted};
use spade_core::goal::verify::{self, Answer};
use spade_core::goal::view::{self, TaskView};
use spade_core::goal::{Author, TASK_GOAL, Task};
use spade_core::turn::stop_requested;
use spade_core::wake::{self, ParkReason, Purpose};
use spade_store::StoreError;

use super::Engine;
use crate::tools::ToolOutput;

/// Longest a check may take before it is stored as not checked.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(60);
pub(super) const VERIFYING: &str = "Checking the work against the goal";

/// What the person sends to set or change the goal.
#[derive(Debug, Clone)]
pub struct GoalInput {
    pub title: String,
    /// The goal in the person's words; an open goal keeps its own when absent.
    pub text: Option<String>,
    pub criteria: Vec<String>,
    /// The model that checks the goal; the review model when absent.
    pub verifier: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum GoalError {
    #[error("no such agent")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    #[error("the agent has no open goal")]
    NoGoal,
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl Engine {
    /// Answers a `task_goal` or `task_plan` call: stores what it changes with its result, or
    /// gives the refusal as the result. Checked and stored under the lock every write holds, so
    /// several plan calls in one step each see the ones before. `None` when the person stopped
    /// the reply.
    pub(super) fn goal_call(
        &self,
        id: &str,
        reply: &str,
        name: &str,
        arguments: &Value,
    ) -> Result<Option<ToolOutput>, StoreError> {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let events = self.load(id)?;
        if stop_requested(&events, reply) {
            return Ok(None);
        }
        let decided = if name == TASK_GOAL {
            let words = spade_core::review::person_words(&events)
                .pop()
                .or_else(|| spade_core::context::task_for_turn(&events).map(str::to_owned));
            // The package's `criterion` checks join the bot's criteria (ADR 0204 §3).
            let required = self
                .agent_of(id)
                .map(|agent| spade_core::package::checks::criteria(&self.checks_of(&agent)))
                .unwrap_or_default();
            change::goal(&events, arguments, words.as_deref(), &required)
        } else {
            change::plan(&events, arguments)
        };
        Ok(Some(match decided {
            Ok(Accepted {
                events: stored,
                result,
            }) => {
                let stored: Vec<Event> = stored.into_iter().map(Event::Known).collect();
                self.append_events(id, &stored)?;
                ToolOutput::ok(result)
            }
            Err(why) => ToolOutput::error(why),
        }))
    }

    /// Checks the bot's claim of done: one fresh model call that sees the goal, its criteria, the
    /// plan and the evidence. Stores the verdict unless `token` was called off meanwhile (a Stop),
    /// then lets the task carry on: a "not yet" sends the bot back to work. A verdict on a goal or
    /// claim that changed while the model answered is dropped, and the claim checked again.
    pub(super) async fn verify_claim(self: &Arc<Self>, id: &str, claim: &str, token: &str) {
        let Ok(events) = self.load(id) else { return };
        let Some(task) = Task::fold(&events).filter(|t| t.goal.closed.is_none()) else {
            return;
        };
        let model = task
            .goal
            .verifier
            .clone()
            .unwrap_or_else(|| self.role_model(id, spade_core::routing::Role::Verify));
        let prompt = verify::prompt(&events, &task).session(id);
        let admitted = self
            .admit(id, &model)
            .for_role(spade_core::routing::Role::Verify);
        let verdict = {
            let asked = tokio::time::timeout(
                VERIFY_TIMEOUT,
                self.models.generate::<Answer>(&model, &prompt),
            )
            .await;
            match asked {
                Ok(Ok(generated)) => {
                    let cost = admitted.settle(&generated.usage);
                    verify::verdict(&task, claim, generated.value, &model, cost)
                }
                // The check's model is down for a while: it waits it out and runs again.
                Ok(Err(error)) if error.transient() => {
                    admitted.settle_if(error.usage());
                    if self.take_token(id, token) {
                        self.set_status(id, None);
                        self.park_check(id, &error);
                    }
                    return;
                }
                Ok(Err(error)) => {
                    let cost = admitted.settle_if(error.usage());
                    // The error names models and types: for the logs, not the person.
                    tracing::warn!(%error, conversation = id, "the check of done failed");
                    verify::unchecked(&task, claim, "The check couldn't run.", &model, cost)
                }
                Err(_) => verify::unchecked(&task, claim, "The check took too long.", &model, 0),
            }
        };
        // The verdict holds only for the goal and claim it was asked about: the person may have
        // changed the criteria, or the bot made a new claim, while the model answered.
        let carry_on = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let same = self
                .load(id)
                .ok()
                .and_then(|now| Task::fold(&now))
                .is_some_and(|now| now.goal == task.goal && now.claim == task.claim);
            if !self.drop_token(id, token) {
                false
            } else if !same {
                // Dropped; carrying on checks the claim again against the goal as it is now.
                true
            } else {
                match self.append(id, &Event::Known(verdict)) {
                    Ok(_) => true,
                    Err(error) => {
                        tracing::error!(%error, "could not store a task's check");
                        false
                    }
                }
            }
        };
        self.set_status(id, None);
        self.remember_episodes(id);
        if carry_on {
            self.carry_on(id);
        }
    }

    /// Forgets the planned check `token`; whether it was still the plan (a Stop calls it off).
    /// The caller holds `record_lock`.
    fn drop_token(&self, id: &str, token: &str) -> bool {
        let mut pending = self.continuations.lock().unwrap_or_else(|p| p.into_inner());
        let current = pending.get(id).is_some_and(|t| t == token);
        if current {
            pending.remove(id);
        }
        current
    }

    /// [`Engine::drop_token`] under `record_lock`.
    fn take_token(&self, id: &str, token: &str) -> bool {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        self.drop_token(id, token)
    }

    /// Parks the task's check of done after its model failed in a way that may pass: a wake
    /// fires at the backoff (1, 2, 4 … minutes, at most an hour, or the endpoint's longer
    /// `retry-after`), and the check runs again. Until then the task reads as checking, never
    /// done.
    fn park_check(self: &Arc<Self>, id: &str, error: &spade_models::ModelError) {
        let Ok(events) = self.load(id) else { return };
        let attempt = wake::next_park_attempt(&events);
        let asked = error
            .retry_after()
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        let due = self
            .now_ms()
            .saturating_add(wake::retry_after_ms(attempt, asked));
        let purpose = Purpose::Park {
            reason: ParkReason::Check,
            attempt,
        };
        let why = super::wakes::short(&error.to_string());
        if let Err(error) = self.set_wake(id, purpose, Some(due), None, &why) {
            tracing::error!(%error, "could not park a task's check of done");
        }
    }

    /// The agent's latest goal with its plan, evidence, verdict and progress.
    pub fn task_view(&self, agent: &str) -> Result<Option<TaskView>, GoalError> {
        let agent = self.store.agent(agent)?.ok_or(GoalError::NotFound)?;
        Ok(view::task(&self.load(&agent.conversation)?))
    }

    /// The person sets the goal, or changes the open one (its plan stays). Only the person can
    /// change an open goal's criteria.
    pub fn set_goal(&self, agent: &str, input: GoalInput) -> Result<TaskView, GoalError> {
        let agent = self.store.agent(agent)?.ok_or(GoalError::NotFound)?;
        let id = agent.conversation;
        let criteria = change::criteria(&input.criteria).map_err(GoalError::Invalid)?;
        let title = input.title.trim().to_owned();
        if title.is_empty() || title.chars().count() > 500 {
            return Err(GoalError::Invalid(
                "the title must be 1 to 500 characters".to_owned(),
            ));
        }
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(&id)?;
            let task = Task::fold(&events);
            let open = task.as_ref().filter(|t| t.goal.closed.is_none());
            let goal = match open {
                Some(t) => t.goal.id.clone(),
                None => format!("g{}", task.as_ref().map_or(0, |t| t.goals) + 1),
            };
            let text = input
                .text
                .map(|t| t.trim().to_owned())
                .filter(|t| !t.is_empty())
                .or_else(|| open.map(|t| t.goal.text.clone()))
                .unwrap_or_else(|| title.clone());
            let set = Event::Known(Known::GoalSet {
                goal,
                title,
                text,
                criteria,
                by: Author::Person,
                verifier: input.verifier.filter(|v| !v.trim().is_empty()),
                run: open.and_then(|t| t.goal.run.clone()),
            });
            self.append(&id, &set)?;
        }
        self.announce(&id);
        view::task(&self.load(&id)?).ok_or(GoalError::NoGoal)
    }

    /// The person ends the open goal without it being done.
    pub fn clear_goal(&self, agent: &str) -> Result<(), GoalError> {
        self.end_goal(agent, false)
    }

    /// The person ends the open goal without it being done; `failed` records it as failed in
    /// its episode (ADR 0164).
    pub fn end_goal(&self, agent: &str, failed: bool) -> Result<(), GoalError> {
        let agent = self.store.agent(agent)?.ok_or(GoalError::NotFound)?;
        let id = agent.conversation;
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(&id)?;
            let goal = Task::fold(&events)
                .filter(|t| t.goal.closed.is_none())
                .ok_or(GoalError::NoGoal)?
                .goal
                .id;
            self.append(&id, &Event::Known(Known::GoalCleared { goal, failed }))?;
        }
        self.remember_episodes(&id);
        self.announce(&id);
        Ok(())
    }
}
