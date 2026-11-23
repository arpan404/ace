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

pub use view::ENDED_SHOWN;

use std::sync::Arc;

use spade_core::event::Known;
use spade_core::helper::{self, Stage};
use spade_core::lane::{self, State};
use spade_core::tree::{self, Kind, Report};
use spade_core::{Event, Transcript};
use spade_store::{StoreError, StoredHelper};

use super::Engine;
use super::roster::State as Activity;

/// Lanes' state the engine keeps in memory.
#[derive(Default)]
pub(super) struct Shared {
    /// Jobs that moved with main's work, by `<main>.<job>`: the lane they report to now. Their
    /// running task still knows them by main, so it looks here (ADR 0217 §2a).
    moved_jobs: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

/// The marker that keeps a queued lane from ever starting.
fn queued_stop() -> Event {
    Event::Known(Known::StopRequested {
        reply: None,
        jobs: Vec::new(),
    })
}

impl Engine {
    /// The lane job `job` of `id` moved to, if it moved.
    pub(super) fn moved_job(&self, id: &str, job: &str) -> Option<String> {
        self.lanes
            .moved_jobs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&format!("{id}.{job}"))
            .cloned()
    }

    /// Where job `job` started in `id` lives now: the lane it moved to, else `id`.
    pub(super) fn job_home(&self, id: &str, job: &str) -> String {
        self.moved_job(id, job).unwrap_or_else(|| id.to_owned())
    }

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

    /// The lanes of `main` that haven't ended, oldest first: what slots, roll-up, Stop, the
    /// tasks block and the tree read, never every lane the bot ran (ADR 0170).
    pub(super) fn live_lanes_of(&self, main: &str) -> Vec<StoredHelper> {
        self.store.live_lanes(Some(main)).unwrap_or_default()
    }

    /// A lane's title, from its first event.
    pub(super) fn lane_title(&self, id: &str) -> String {
        self.load(id)
            .ok()
            .and_then(|events| lane::title(&events))
            .unwrap_or_else(|| "A task".to_owned())
    }

    /// Where the lane `id` stands now.
    /// Read with everything under it (ADR 0217 §5, AGENTS.md priority 1): never call this under
    /// the record lock, which reading what is under it takes.
    pub(super) fn lane_state(&self, id: &str) -> State {
        match self.load(id) {
            Ok(events) => lane::state(&events, self.around(id, &events)),
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
        let lanes = self.live_lanes_of(main);
        if lanes.is_empty() {
            return;
        }
        // How each stands with what is under it, read before the record lock (which reading it
        // takes): a lane whose reply closed while its job or worker runs holds its slot.
        let states: Vec<(StoredHelper, State)> = lanes
            .into_iter()
            .map(|row| {
                let state = self.lane_state(&row.conversation);
                (row, state)
            })
            .collect();
        let running = states
            .iter()
            .filter(|(_, state)| state.live() && *state != State::Queued)
            .count();
        let mut free = self.limits.tasks_at_once.max(1).saturating_sub(running);
        let model = self.lane_model(main);
        let mut drive = Vec::new();
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if !self.admission.load(std::sync::atomic::Ordering::SeqCst) || self.deleting(main) {
                return;
            }
            for (row, _) in states {
                // Looked at again under the lock: a stop may have marked it since.
                let Ok(events) = self.load(&row.conversation) else {
                    continue;
                };
                let open = Transcript::fold(events.iter()).open_reply().is_some();
                match helper::stage(&events) {
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
        for row in self.live_lanes_of(main) {
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
        // The same fold as its state: its own jobs, waits, continuation and what is under it.
        let around = self.around(id, &events);
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
        let ended_state = settled.state != tree::ReportState::NeedsYou;
        let report = Event::Known(Known::WorkerReported(Report {
            worker: id.to_owned(),
            kind: Kind::Lane,
            name: title,
            state: settled.state,
            epoch: settled.epoch,
            summary: settled.summary,
            words: settled.words,
        }));
        let ended = ended_state;
        match self.deliver_as(&row.parent, &report, None) {
            // Reported (now or before): a lane that ended leaves the live list (ADR 0170), and
            // comes back when it opens a new reply.
            Ok(_) if ended => {
                if let Err(error) = self.store.set_lane_live(id, &row.parent, false) {
                    tracing::error!(%error, "could not mark a task lane ended");
                }
            }
            Ok(_) => {}
            Err(StoreError::NoConversation(_)) => {}
            Err(error) => tracing::error!(%error, "could not report a task lane to its bot"),
        }
    }

    /// Stops every lane of `main` (Stop on the bot, ADR 0217 §5). Every queued one is marked in
    /// one write first, so none is admitted into a slot a stopping lane frees; then each running
    /// one is stopped like any reply. Whether any was stopped.
    pub(in super::super) fn stop_lanes(self: &Arc<Self>, main: &str) -> Result<bool, StoreError> {
        let lanes = self.lanes_of(main);
        if lanes.is_empty() {
            return Ok(false);
        }
        let marked = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let mut marked = Vec::new();
            for row in &lanes {
                if helper::stage(&self.load(&row.conversation)?) == Stage::Queued {
                    self.append(&row.conversation, &queued_stop())?;
                    marked.push(row.conversation.clone());
                }
            }
            marked
        };
        let mut any = !marked.is_empty();
        for row in &lanes {
            if marked.contains(&row.conversation) {
                self.check_lane(&row.conversation);
            } else {
                any |= self.end_work(&row.conversation, Self::stop_wakes)?;
            }
        }
        Ok(any)
    }

    /// Stops one lane and what it started, only it (ADR 0217 §5): a queued one is marked so it
    /// never starts, a running one stopped like any reply.
    pub(in super::super) fn stop_lane(self: &Arc<Self>, id: &str) -> Result<bool, StoreError> {
        let queued = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let queued = helper::stage(&self.load(id)?) == Stage::Queued;
            if queued {
                self.append(id, &queued_stop())?;
            }
            queued
        };
        if !queued {
            return self.end_work(id, Self::stop_wakes);
        }
        self.check_lane(id);
        if let Some(row) = self.lane_row(id) {
            self.fill_lanes(&row.parent);
        }
        Ok(true)
    }

    /// The lanes Spade resumes when it opens: every one that started, and not yet ended.
    pub(in super::super) fn lanes_to_resume(&self) -> Vec<String> {
        self.live_lane_rows()
            .into_iter()
            .filter(|row| {
                self.load(&row.conversation)
                    .is_ok_and(|events| helper::stage(&events) != Stage::Queued)
            })
            .map(|row| row.conversation)
            .collect()
    }

    /// The lanes that haven't ended, of every bot.
    pub(in super::super) fn live_lane_rows(&self) -> Vec<StoredHelper> {
        self.all_lanes()
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
        let lanes = self.live_lane_rows();
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
        // From the lanes that haven't ended alone, each read from its own first events.
        let lanes: Vec<(lane::Started, State)> = self
            .live_lanes_of(main)
            .into_iter()
            .filter_map(|row| {
                let events = self.load(&row.conversation).ok()?;
                let link = lane::link(&events)?.clone();
                let started = lane::Started {
                    lane: row.conversation.clone(),
                    conversation: row.conversation.clone(),
                    title: lane::title(&events).unwrap_or(link.title),
                    call: link.call,
                    asks: link.asks,
                    moved_from: link.moved_from,
                    queued: false,
                };
                Some((started, self.lane_state(&row.conversation)))
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

impl Engine {
    /// Notes the files lane `id` wrote that another of its bot's lanes, still working, wrote too
    /// (ADR 0217 §3): `lanes_overlapped` in this lane, read as a plain warning in its next step,
    /// and in main as a line. A note, never a lock. Whether anything was noted.
    pub(in super::super) fn note_overlaps(self: &Arc<Self>, id: &str) -> bool {
        let Some(row) = self.lane_row(id) else {
            return false;
        };
        let Ok(events) = self.load(id) else {
            return false;
        };
        let wrote = lane::written(&events);
        if wrote.is_empty() {
            return false;
        }
        let others: Vec<(String, String, std::collections::BTreeSet<String>)> = self
            .live_lanes_of(&row.parent)
            .into_iter()
            .filter(|other| other.conversation != id)
            .filter(|other| self.lane_state(&other.conversation).live())
            .filter_map(|other| {
                let theirs = self.load(&other.conversation).ok()?;
                let title = lane::title(&theirs).unwrap_or_default();
                Some((other.conversation, title, lane::written(&theirs)))
            })
            .collect();
        let title = lane::title(&events).unwrap_or_default();
        let found = lane::overlaps((id, &title, &wrote), &others, &events);
        for overlap in &found {
            let noted = Event::Known(Known::LanesOverlapped(overlap.clone()));
            for at in [id, row.parent.as_str()] {
                if let Err(error) = self.record(at, &noted) {
                    tracing::error!(%error, "could not note two task lanes writing one file");
                }
            }
        }
        if !found.is_empty() {
            self.announce(&row.parent);
        }
        !found.is_empty()
    }
}
