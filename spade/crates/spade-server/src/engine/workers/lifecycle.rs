//! A tree's lifecycle (ADR 0161): Stop on a bot stops everything under it, and deleting a bot with
//! workers asks what becomes of them: stopped, or kept working, as top-level bots either way.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use spade_core::Event;
use spade_core::event::Known;
use spade_core::tree::{self, AceState, Kind, Report, ReportState};

use super::super::{AgentError, Engine};

/// What becomes of a deleted bot's workers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Workers {
    /// They stop, and stay as top-level bots.
    Stop,
    /// They keep working, as top-level bots.
    Keep,
}

impl Workers {
    pub fn parse(word: &str) -> Option<Self> {
        match word.trim() {
            "stop" => Some(Self::Stop),
            "keep" => Some(Self::Keep),
            _ => None,
        }
    }
}

impl Engine {
    /// Stops `id`'s workers and what is under them, and cancels its ace children still running.
    /// Whether anything was stopped.
    pub(crate) fn stop_workers(self: &Arc<Self>, id: &str) -> bool {
        let mut any = false;
        for child in self.worker_children(id) {
            if self.worker_queued(&child) {
                // It never starts.
                let marker = Event::Known(Known::StopRequested {
                    reply: None,
                    jobs: Vec::new(),
                });
                if self.record(&child, &marker).is_ok() {
                    any = true;
                }
                continue;
            }
            match self.stop(&child) {
                Ok(stopped) => any |= stopped,
                Err(error) => tracing::error!(%error, "could not stop a worker"),
            }
        }
        let Ok(events) = self.load(id) else {
            return any;
        };
        for child in tree::ace_children(events.iter()) {
            if matches!(
                child.state,
                AceState::Working | AceState::NeedsYou | AceState::Limited
            ) {
                self.cancel_ace_child(id, &child.thread, &child.name);
                any = true;
            }
        }
        any
    }

    /// Asks ace to cancel the ace child `thread` of `id`. The intent is stored first (the child
    /// reads stopping, and still counts as running), then the cancel is tried until ace confirms
    /// it, after a restart too ([`Engine::resume_ace_stops`]); only then is it noted stopped.
    pub(super) fn cancel_ace_child(self: &Arc<Self>, id: &str, thread: &str, name: &str) {
        let stopping = ace_report(
            thread,
            name,
            ReportState::Stopping,
            "it is being cancelled.",
        );
        if let Err(error) = self.record(id, &stopping) {
            tracing::error!(%error, "could not note an ace child being stopped");
        }
        self.keep_cancelling(id, thread, name);
    }

    /// After a restart: every ace child still being stopped is cancelled again until ace
    /// confirms.
    pub(super) fn resume_ace_stops(self: &Arc<Self>) {
        let conversations = match self.store.ace_stops() {
            Ok(conversations) => conversations,
            Err(error) => {
                tracing::error!(%error, "could not read the ace children being stopped");
                return;
            }
        };
        for id in conversations {
            let Ok(events) = self.load(&id) else { continue };
            for child in tree::ace_stopping(events.iter()) {
                self.keep_cancelling(&id, &child.thread, &child.name);
            }
        }
    }

    /// Asks ace to cancel `thread` until it answers without an error, waiting longer each time,
    /// then notes the child stopped. Ends early if the child settled meanwhile (a later result
    /// says so) or its bot is gone. One loop per child.
    fn keep_cancelling(self: &Arc<Self>, id: &str, thread: &str, name: &str) {
        let owed = (id.to_owned(), thread.to_owned());
        if !super::lock(&self.workers.cancelling).insert(owed.clone()) {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            super::lock(&self.workers.cancelling).remove(&owed);
            return;
        };
        let weak = Arc::downgrade(self);
        let (id, thread, name) = (id.to_owned(), thread.to_owned(), name.to_owned());
        runtime.spawn(async move {
            let request = format!("spade-stop-{}", id_safe(&thread));
            let key = format!("{id}.{request}");
            let mut wait = Duration::from_millis(250);
            loop {
                let Some(engine) = weak.upgrade() else { return };
                let still = engine.load(&id).is_ok_and(|events| {
                    tree::ace_stopping(events.iter())
                        .iter()
                        .any(|c| c.thread == thread)
                });
                if !still {
                    break;
                }
                let confirmed = match engine.tools.get_for(&id, "agent_cancel") {
                    Some(tool) => {
                        let arguments = json!({ "threadId": thread, "requestId": request });
                        let output = tool.run(&key, arguments).await;
                        if output.is_error {
                            tracing::warn!(answer = %output.content, "ace did not cancel an ace child; trying again");
                        }
                        !output.is_error
                    }
                    None => {
                        tracing::warn!("ace's agent_cancel is not here; an ace child's cancel waits");
                        false
                    }
                };
                if confirmed {
                    let stopped =
                        ace_report(&thread, &name, ReportState::Stopped, "it was cancelled.");
                    match engine.record(&id, &stopped) {
                        Ok(_) => {
                            engine.announce(&id);
                            for up in engine.worker_ancestors(&id) {
                                engine.announce(&up);
                            }
                            break;
                        }
                        Err(spade_store::StoreError::NoConversation(_)) => break,
                        Err(error) => tracing::error!(%error, "could not note an ace child stopped"),
                    }
                }
                drop(engine);
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(Duration::from_secs(30));
            }
            if let Some(engine) = weak.upgrade() {
                super::lock(&engine.workers.cancelling).remove(&(id, thread));
            }
        });
    }

    /// Deletes bot `id` and, first, deals with its workers as `workers` says: each is stopped
    /// (with what is under it) or left working, and either way stops being a worker.
    pub async fn delete_agent_with(
        self: &Arc<Self>,
        id: &str,
        workers: Workers,
    ) -> Result<(), AgentError> {
        let agent = self.store.agent(id)?.ok_or(AgentError::NotFound)?;
        for child in self.worker_children(&agent.conversation) {
            // A queued worker's brief is held in its link, which detaching ends: read first.
            let held = self
                .worker_queued(&child)
                .then(|| self.worker_link(&child))
                .flatten();
            if workers == Workers::Stop {
                let _ = self.stop(&child);
            }
            let detached = Event::Known(Known::WorkerDetached {
                by: "person".to_owned(),
            });
            self.record(&child, &detached)?;
            // Kept working: a queued one starts on its brief now, as a bot of its own, rather
            // than waiting for a slot of a maker that is gone.
            if let (Workers::Keep, Some(link)) = (workers, held) {
                let brief = self.brief_message(&child, &link);
                self.deliver(&child, &brief)?;
            }
        }
        self.delete_agent_now(id).await
    }

    /// Before bot `conversation` is deleted: its parent's tree notes it gone (quietly), and the
    /// tree forgets it.
    pub(crate) fn worker_deleted(&self, conversation: &str) {
        if let Some(link) = self.worker_link(conversation)
            && let Ok(Some(agent)) = self.store.agent_for_conversation(conversation)
        {
            let gone = Event::Known(Known::WorkerReported(Report {
                worker: agent.id,
                kind: Kind::Bot,
                name: agent.name,
                state: ReportState::Stopped,
                epoch: "deleted".to_owned(),
                summary: "the person deleted it.".to_owned(),
                words: None,
            }));
            let _ = self.record(&link.parent_conversation, &gone);
        }
        self.forget_worker(conversation);
    }
}

/// A note on ace child `thread` in its bot's conversation.
fn ace_report(thread: &str, name: &str, state: ReportState, summary: &str) -> Event {
    Event::Known(Known::WorkerReported(Report {
        worker: thread.to_owned(),
        kind: Kind::Ace,
        name: name.to_owned(),
        state,
        epoch: state.name().to_owned(),
        summary: summary.to_owned(),
        words: None,
    }))
}

/// Only the characters ace accepts in an id.
pub(super) fn id_safe(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}
