//! Closing for an update or a stop (docs/ace-integration.md, "Updates" and "Stop"). Admission
//! closes first: messages are still stored, no turn starts. Then, once the mode's rule says so
//! (`spade_core::maintenance`), every turn worker is told to pause; each records `turn_paused`
//! and exits, and the reply resumes from its events when Spade starts or admission reopens.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use spade_core::Transcript;
use spade_core::context::MAYBE_RAN;
use spade_core::event::{Event, Known};
use spade_core::maintenance::{self, HOLD_AFTER_PAUSE, Load, Mode, Pause};
use tokio::time::Instant;

use super::Engine;

/// How often the closing task looks at what is still running.
const POLL: Duration = Duration::from_millis(25);

/// How long a stop waits for workers to record their pause once told to pause now.
const SETTLE: Duration = Duration::from_secs(2);

/// What `GET /v1/maintenance` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaintenanceState {
    pub admission_open: bool,
    /// Turn workers still running (working, or waiting on the person and not yet paused).
    pub running_turns: usize,
    pub running_jobs: usize,
}

impl Engine {
    pub fn maintenance_state(&self) -> MaintenanceState {
        let (running_turns, _, running_jobs) = self.load_now();
        MaintenanceState {
            admission_open: self.admission.load(Ordering::SeqCst),
            running_turns,
            running_jobs,
        }
    }

    /// Closes admission for an update and pauses open turns once `mode` allows. In `idle` mode a
    /// `deadline` bounds the wait for idleness: when it passes first, admission reopens and
    /// nothing is paused. In `now` mode it shortens the 30 s a running model step may take.
    pub fn begin_maintenance(self: &Arc<Self>, mode: Mode, deadline: Option<Duration>) {
        let generation = self.close_admission();
        let engine = self.clone();
        tokio::spawn(async move {
            let current = || engine.maintenance.load(Ordering::SeqCst) == generation;
            match mode {
                Mode::Idle => {
                    let give_up = deadline.map(|d| Instant::now() + d);
                    loop {
                        if !current() {
                            return;
                        }
                        let (_, working_turns, running_jobs) = engine.load_now();
                        let load = Load {
                            working_turns,
                            running_jobs,
                        };
                        if maintenance::ready(Mode::Idle, load) {
                            break;
                        }
                        if give_up.is_some_and(|at| Instant::now() >= at) {
                            tracing::warn!(
                                "Spade was not idle by the update's deadline; reopening"
                            );
                            engine.reopen_if(generation);
                            return;
                        }
                        tokio::time::sleep(POLL).await;
                    }
                    if !engine.publish_if(generation, Pause::AfterStep) {
                        return;
                    }
                }
                Mode::Now => {
                    // A reopen may already have come before this task first ran.
                    if !engine.publish_if(generation, Pause::AfterStep) {
                        return;
                    }
                    let allowance = maintenance::step_allowance(deadline);
                    engine.wait_for_turns(allowance, &current).await;
                    if !engine.publish_if(generation, Pause::Now) {
                        return;
                    }
                }
            }
            // Every turn is paused; if the restart never comes (the updater died), Spade
            // carries on by itself.
            tokio::time::sleep(HOLD_AFTER_PAUSE).await;
            if current() {
                tracing::warn!("no restart came after pausing for an update; reopening");
                engine.reopen_if(generation);
            }
        });
    }

    /// Reopens admission (an update was aborted): paused turns resume and messages stored while
    /// closed are answered.
    pub fn end_maintenance(self: &Arc<Self>) {
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            self.maintenance.fetch_add(1, Ordering::SeqCst);
            self.open_admission();
        }
        self.resume_all();
    }

    /// For a plain stop (SIGTERM): closes admission, lets running model steps finish within
    /// `allowance`, then pauses every open turn and waits briefly for each to record it.
    pub async fn pause_for_stop(self: &Arc<Self>, allowance: Duration) {
        let generation = self.close_admission();
        let current = || self.maintenance.load(Ordering::SeqCst) == generation;
        if !self.publish_if(generation, Pause::AfterStep) {
            return;
        }
        self.wait_for_turns(allowance, &current).await;
        if !self.publish_if(generation, Pause::Now) {
            return;
        }
        self.wait_for_turns(SETTLE, &current).await;
    }

    /// Generation changes, admission and the pause signal all change under `record_lock`, so a
    /// closing task can never publish a pause after a newer request (or a reopen).
    fn close_admission(&self) -> u64 {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        self.admission.store(false, Ordering::SeqCst);
        self.maintenance.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Tells turn workers `pause` if request `generation` is still the current one. The value is
    /// stored even when no worker is listening (all paused ones have exited), so a worker started
    /// later reads it. Returns whether it was published.
    fn publish_if(&self, generation: u64, pause: Pause) -> bool {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        if self.maintenance.load(Ordering::SeqCst) != generation {
            return false;
        }
        self.pause.send_replace(pause);
        true
    }

    fn reopen_if(self: &Arc<Self>, generation: u64) {
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.maintenance.load(Ordering::SeqCst) != generation {
                return;
            }
            self.maintenance.fetch_add(1, Ordering::SeqCst);
            self.open_admission();
        }
        self.resume_all();
    }

    /// Opens admission and tells workers to run; the caller holds `record_lock`. `send_replace`
    /// always stores, even with no worker listening, so resumed workers read `Off`.
    fn open_admission(&self) {
        self.admission.store(true, Ordering::SeqCst);
        self.pause.send_replace(Pause::Off);
    }

    /// Resumes paused turns and answers messages stored while closed.
    fn resume_all(self: &Arc<Self>) {
        let conversations = match self.store.conversations() {
            Ok(conversations) => conversations,
            Err(error) => {
                tracing::error!(%error, "could not list conversations to resume them");
                return;
            }
        };
        for conversation in conversations {
            if let Err(error) = self.resume(&conversation.id) {
                tracing::error!(%error, "could not resume a conversation");
            }
        }
    }

    /// Waits until no turn worker runs, `limit` passes, or `current` turns false.
    async fn wait_for_turns(&self, limit: Duration, current: impl Fn() -> bool) {
        let until = Instant::now() + limit;
        while current() && Instant::now() < until && self.load_now().0 > 0 {
            tokio::time::sleep(POLL).await;
        }
    }

    /// Turn workers running, those of them working (not waiting on the person), and running
    /// background jobs.
    fn load_now(&self) -> (usize, usize, usize) {
        let live: Vec<_> = self
            .live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect();
        let mut running = 0;
        let mut working = 0;
        let mut jobs = 0;
        for conversation in live {
            if conversation.turn_running.load(Ordering::SeqCst) {
                running += 1;
                if !conversation.waiting_on_you.load(Ordering::SeqCst) {
                    working += 1;
                }
            }
            jobs += conversation
                .jobs
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .len();
        }
        (running, working, jobs)
    }
}

/// Records that `reply` paused. Tools it was running were cut, so each is answered first as
/// maybe run: the model checks before trying again.
pub(super) fn record_paused(engine: &Engine, id: &str, reply: &str) {
    // Read and written under one lock, so a tool result can't land between them.
    let _order = engine.record_lock.lock().unwrap_or_else(|p| p.into_inner());
    let events = match engine.load(id) {
        Ok(events) => events,
        Err(error) => {
            // Unrecorded, a restart closes the reply as interrupted: still truthful.
            tracing::error!(%error, "could not record a paused turn");
            return;
        }
    };
    let transcript = Transcript::fold(&events);
    let mut records: Vec<Event> = transcript
        .running
        .iter()
        .map(|call_id| {
            Event::Known(Known::ToolFinished {
                reply: reply.to_owned(),
                call_id: call_id.clone(),
                name: tool_name(&events, call_id),
                content: MAYBE_RAN.to_owned(),
                is_error: true,
                images: Vec::new(),
                uncertain: true,
            })
        })
        .collect();
    if !records.is_empty() || !transcript.paused {
        records.push(Event::Known(Known::TurnPaused {
            reply: reply.to_owned(),
        }));
    }
    if let Err(error) = engine.append_events(id, &records) {
        tracing::error!(%error, "could not record a paused turn");
    }
}

fn tool_name(events: &[Event], call_id: &str) -> String {
    events
        .iter()
        .find_map(|event| match event {
            Event::Known(Known::ToolStarted {
                call_id: c, name, ..
            }) if c == call_id => Some(name.clone()),
            _ => None,
        })
        .unwrap_or_default()
}
