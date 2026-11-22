//! What the Working line says while a bot works (ADR 0127's few words), in the order the bot
//! itself says it: the headline its model gave for the step it is on, else the step of its plan
//! in progress, else what its tool call does (`spade_core::activity::doing`). Plain "Thinking"
//! stands only while there is nothing of its own to say.

use super::Engine;
use super::roster::THINKING;

/// The bot's own words for its open reply.
#[derive(Default)]
pub(super) struct Said {
    /// The newest headline of the model's reasoning in the step running now.
    headline: Option<String>,
    /// The step of its `todo` plan in progress, for the whole reply.
    plan: Option<String>,
}

impl Said {
    /// What a status of `status` reads as: plain "Thinking" gives way to its own words.
    pub(super) fn over(&self, status: Option<String>) -> Option<String> {
        match status {
            Some(status) if status == THINKING => Some(
                self.headline
                    .clone()
                    .or_else(|| self.plan.clone())
                    .unwrap_or(status),
            ),
            other => other,
        }
    }

    fn shown(&self, status: Option<&str>) -> bool {
        status == Some(THINKING)
            || (status.is_some()
                && (status == self.headline.as_deref() || status == self.plan.as_deref()))
    }
}

impl Engine {
    /// A new model step began: the last step's headline no longer says what it does.
    pub(crate) fn step_began(&self, id: &str) {
        self.live(id)
            .said
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .headline = None;
    }

    /// The model's reasoning gave a headline: it is the line while the line is its own words
    /// or plain "Thinking", not while a tool, a retry or a review says something else.
    pub(crate) fn reasoned(&self, id: &str, headline: String) {
        let live = self.live(id);
        {
            let mut said = live.said.lock().unwrap_or_else(|p| p.into_inner());
            if said.headline.as_deref() == Some(headline.as_str()) {
                return;
            }
            let mut status = live.status.lock().unwrap_or_else(|p| p.into_inner());
            let shown = said.shown(status.as_deref());
            said.headline = Some(headline.clone());
            if !shown {
                return;
            }
            *status = Some(headline);
        }
        self.announce(id);
    }

    /// A tool call starts: the line keeps the bot's own words when it has them, else says what
    /// the call does. A `todo` call sets the plan's step first.
    pub(crate) fn tool_started_status(
        &self,
        id: &str,
        name: &str,
        arguments: &serde_json::Value,
        phrase: String,
    ) {
        let status = {
            let live = self.live(id);
            let mut said = live.said.lock().unwrap_or_else(|p| p.into_inner());
            if name == "todo" {
                said.plan = spade_core::activity::doing::plan_step(arguments);
            }
            said.headline
                .clone()
                .or_else(|| said.plan.clone())
                .unwrap_or(phrase)
        };
        self.set_status(id, Some(status));
    }
}
