//! A tree's lifecycle (ADR 0161): Stop on a bot stops everything under it, and deleting a bot with
//! workers asks what becomes of them: stopped, or kept working, as top-level bots either way.

use std::sync::Arc;

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

    /// Asks ace to cancel the ace child `thread` of `id`, and notes it stopped.
    pub(super) fn cancel_ace_child(self: &Arc<Self>, id: &str, thread: &str, name: &str) {
        let stopped = Event::Known(Known::WorkerReported(Report {
            worker: thread.to_owned(),
            kind: Kind::Ace,
            name: name.to_owned(),
            state: ReportState::Stopped,
            epoch: "stop".to_owned(),
            summary: "it was cancelled.".to_owned(),
            words: None,
        }));
        if let Err(error) = self.record(id, &stopped) {
            tracing::error!(%error, "could not note an ace child stopped");
        }
        let request = format!("spade-stop-{}", id_safe(thread));
        self.run_ace(
            id,
            "agent_cancel",
            &request,
            json!({ "threadId": thread, "requestId": request }),
        );
    }

    /// Runs one of ace's tools for `id` in the background; what it answers is only logged.
    fn run_ace(self: &Arc<Self>, id: &str, name: &str, call: &str, arguments: serde_json::Value) {
        let Some(tool) = self.tools.get_for(id, name) else {
            tracing::warn!(
                tool = name,
                "ace's tool is not here; an ace child was not told"
            );
            return;
        };
        let key = format!("{id}.{call}");
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(async move {
            let output = tool.run(&key, arguments).await;
            if output.is_error {
                tracing::warn!(answer = %output.content, "ace refused a call for an ace child");
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
            if workers == Workers::Stop {
                let _ = self.stop(&child);
            }
            let detached = Event::Known(Known::WorkerDetached {
                by: "person".to_owned(),
            });
            self.record(&child, &detached)?;
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
