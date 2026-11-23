//! Task lanes (ADR 0217, docs/workers.md "Lanes"): a bot runs each independent request of the
//! person's as a task of its own. A lane is a hidden conversation of its bot, stored beside its
//! helpers (profile `lane`), so it shares the bot's workspace, notes, settings and spend and is
//! carried and deleted with it. Unlike a helper it has its own goal, plan and asks, the person can
//! write in it, and it reports back to main when it settles. The rules are `spade_core::lane`.
//!
//! - `start`: `task_start`, and Spade moving main's long work to a lane;
//! - `talk`: `task_message`, a person's reply routed to its lane, `task_stop`, `tasks`;
//! - `view`: the task list (`GET /v1/conversations/{id}/tasks`);
//! - here: which conversations are lanes, slots, how a lane stands, its report, Stop, restarts.

mod start;
mod talk;
mod view;

use std::sync::Arc;

use spade_core::event::Known;
use spade_core::helper::{self, Stage};
use spade_core::lane::{self, State};
use spade_core::tree::{self, Kind, Report};
use spade_core::{Event, Transcript};
use spade_store::{StoreError, StoredHelper};

use super::Engine;
use super::roster::State as Activity;

impl Engine {
    /// The lane whose conversation is `id`, if it is one.
    pub(super) fn lane_row(&self, id: &str) -> Option<StoredHelper> {
        self.hidden_of(id)
            .filter(|row| row.profile == lane::PROFILE)
    }

    /// Whether conversation `id` is one of a bot's task lanes.
    pub(crate) fn is_lane(&self, id: &str) -> bool {
        self.lane_row(id).is_some()
    }

    /// The lanes of the bot conversation `main`, oldest first (the order queued ones start in).
    pub(super) fn lanes_of(&self, main: &str) -> Vec<StoredHelper> {
        self.store
            .helpers_of(main)
            .map(|rows| {
                rows.into_iter()
                    .filter(|row| row.profile == lane::PROFILE)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A lane's title, from its first event.
    pub(super) fn lane_title(&self, id: &str) -> String {
        self.load(id)
            .ok()
            .and_then(|events| lane::title(&events))
            .unwrap_or_else(|| "A task".to_owned())
    }

    /// Where the lane `id` stands now.
    pub(super) fn lane_state(&self, id: &str) -> State {
        match self.load(id) {
            Ok(events) => lane::state(&events, self.continuing(id, false)),
            Err(_) => State::Stopped,
        }
    }

    /// The model a lane's reply starts on: the `task` role of its bot (ADR 0217 §8a).
    pub(super) fn lane_model(&self, main: &str) -> String {
        self.role_model(main, spade_core::routing::Role::Task)
    }

    /// Starts `main`'s queued lanes while slots are free, oldest first, and a worker for each
    /// running lane that has none (after a restart or a pause). Nothing starts while Spade is
    /// closing or the bot is being deleted.
    pub(super) fn fill_lanes(self: &Arc<Self>, main: &str) {
        let lanes = self.lanes_of(main);
        if lanes.is_empty() {
            return;
        }
        let mut drive = Vec::new();
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if !self.admission.load(std::sync::atomic::Ordering::SeqCst) || self.deleting(main) {
                return;
            }
            let stages: Vec<(StoredHelper, Stage, bool)> = lanes
                .into_iter()
                .map(|row| {
                    let (stage, open) =
                        self.load(&row.conversation)
                            .map_or((Stage::Ended, false), |events| {
                                let open = Transcript::fold(events.iter()).open_reply().is_some();
                                (helper::stage(&events), open)
                            });
                    (row, stage, open)
                })
                .collect();
            let running = stages
                .iter()
                .filter(|(_, stage, open)| *stage == Stage::Running || *open);
            let mut free = self
                .limits
                .tasks_at_once
                .max(1)
                .saturating_sub(running.count());
            let model = self.lane_model(main);
            for (row, stage, open) in stages {
                match stage {
                    _ if open => drive.push(row.conversation),
                    Stage::Queued if free > 0 => {
                        let started = Event::reply_started(self.ids.next("r"), &model);
                        match self.append(&row.conversation, &started) {
                            Ok(_) => {
                                free -= 1;
                                drive.push(row.conversation);
                            }
                            Err(error) => tracing::error!(%error, "could not start a task lane"),
                        }
                    }
                    _ => {}
                }
            }
        }
        for conversation in drive {
            self.spawn_turn(&conversation);
        }
    }

    /// After a lane's reply closed: a queued lane may take its slot, and the lane is checked for
    /// its report.
    pub(super) fn lane_ended(self: &Arc<Self>, id: &str) {
        let Some(row) = self.lane_row(id) else {
            return;
        };
        self.fill_lanes(&row.parent);
        self.check_lane(id);
    }

    /// The rolled-up state of `main`'s lanes and how many haven't ended: working while one
    /// works or waits for a slot, waiting while one waits on the person (ADR 0217 §7).
    pub(super) fn lanes_rolled(&self, main: &str) -> (Activity, usize) {
        let mut state = Activity::Idle;
        let mut live = 0;
        for row in self.lanes_of(main) {
            let lane = self.lane_state(&row.conversation);
            let own = match lane {
                State::NeedsYou => Activity::Waiting,
                State::Working | State::Queued => Activity::Working,
                _ => continue,
            };
            live += 1;
            state = spade_core::running::rolled(state, own);
        }
        (state, live)
    }

    /// Reports lane `id` to main once it has settled, once per state per epoch (ADR 0217 §4).
    /// A lane the person stopped is reported `stopped`, which opens no reply.
    pub(super) fn check_lane(self: &Arc<Self>, id: &str) {
        let Some(row) = self.lane_row(id) else {
            return;
        };
        if self.deleting(&row.parent) {
            return;
        }
        let Ok(events) = self.load(id) else { return };
        if helper::stage(&events) == Stage::Queued {
            return;
        }
        let around = tree::Around {
            carries_on: self.continuing(id, false)
                || matches!(
                    spade_core::task::next(&events, &self.limits.task),
                    spade_core::task::Next::Continue { .. }
                ),
            ..tree::Around::default()
        };
        let settled = match tree::settled(&events, around) {
            Some(settled) => settled,
            // Stopped before it began: no reply to settle in.
            None if helper::stage(&events) == Stage::Ended
                && !events
                    .iter()
                    .any(|e| matches!(e, Event::Known(Known::ReplyStarted { .. }))) =>
            {
                tree::Settled {
                    state: tree::ReportState::Stopped,
                    epoch: "queued".to_owned(),
                    summary: "it was stopped before it began.".to_owned(),
                    words: None,
                }
            }
            None => return,
        };
        let title = lane::title(&events).unwrap_or_else(|| "A task".to_owned());
        let report = Event::Known(Known::WorkerReported(Report {
            worker: id.to_owned(),
            kind: Kind::Lane,
            name: title,
            state: settled.state,
            epoch: settled.epoch,
            summary: settled.summary,
            words: settled.words,
        }));
        match self.deliver_as(&row.parent, &report, None) {
            Ok(_) => {}
            Err(StoreError::NoConversation(_)) => {}
            Err(error) => tracing::error!(%error, "could not report a task lane to its bot"),
        }
    }

    /// Stops every lane of `main` (Stop on the bot, ADR 0217 §5): a running one like any reply,
    /// a queued one with a marker so it never starts. Whether any was stopped.
    pub(super) fn stop_lanes(self: &Arc<Self>, main: &str) -> bool {
        let mut any = false;
        for row in self.lanes_of(main) {
            any |= self.stop_lane(&row.conversation);
        }
        any
    }

    /// Stops one lane and what it started, only it (ADR 0217 §5).
    pub(super) fn stop_lane(self: &Arc<Self>, id: &str) -> bool {
        let queued = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            match self.load(id) {
                Ok(events) if helper::stage(&events) == Stage::Queued => {
                    let marker = Event::Known(Known::StopRequested {
                        reply: None,
                        jobs: Vec::new(),
                    });
                    if let Err(error) = self.append(id, &marker) {
                        tracing::error!(%error, "could not stop a queued task lane");
                    }
                    true
                }
                _ => false,
            }
        };
        if queued {
            self.check_lane(id);
            if let Some(row) = self.lane_row(id) {
                self.fill_lanes(&row.parent);
            }
            return true;
        }
        match self.stop(id) {
            Ok(stopped) => stopped,
            Err(error) => {
                tracing::error!(%error, "could not store a task lane's stop");
                false
            }
        }
    }

    /// Every lane's conversation, for checking owed reports when Spade opens.
    pub(super) fn all_lanes(&self) -> Vec<StoredHelper> {
        self.store
            .helpers()
            .map(|rows| {
                rows.into_iter()
                    .filter(|row| row.profile == lane::PROFILE)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// When Spade opens for work: every bot's lanes carry on (queued ones start as slots free),
    /// and every lane is checked, so a report owed from before a restart arrives once.
    pub(super) fn resume_lanes(self: &Arc<Self>) {
        let lanes = self.all_lanes();
        let mut mains: Vec<String> = lanes.iter().map(|row| row.parent.clone()).collect();
        mains.sort();
        mains.dedup();
        for main in mains {
            self.fill_lanes(&main);
        }
        for row in lanes {
            self.check_lane(&row.conversation);
        }
    }
}

impl Engine {
    /// `prompt` closed by main's tasks block while lanes haven't ended (ADR 0217 §6): one line
    /// each, read from the events and never from a summary, so a compaction loses none.
    pub(super) fn with_lanes_block(
        &self,
        main: &str,
        mut prompt: spade_models::Prompt,
    ) -> spade_models::Prompt {
        if self.hidden_of(main).is_some() {
            return prompt;
        }
        let Ok(events) = self.load(main) else {
            return prompt;
        };
        let lanes: Vec<(lane::Started, State)> = lane::started(&events)
            .into_iter()
            .map(|started| {
                let state = self.lane_state(&started.conversation);
                (started, state)
            })
            .collect();
        if let Some(text) = lane::block(&lanes) {
            prompt.messages.push(spade_models::Message::Person {
                text,
                images: Vec::new(),
            });
        }
        prompt
    }
}
