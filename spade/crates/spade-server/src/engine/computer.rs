//! The person takes a bot's computer and hands it back (ADR 0142). While they have it the bot's
//! turn pauses at its next safe point, exactly as for an update (`maintenance`), but only for
//! this conversation; messages sent meanwhile are stored and wait. Handing back stores Spade's
//! note on what the person did, then the paused turn carries on, or the waiting messages are
//! answered.

use std::sync::Arc;

use spade_core::event::{Event, Known};
use spade_core::maintenance::Pause;
use tokio::sync::watch;

use super::{Engine, Live};
use crate::computer::{Computers, Kind};

/// The status a working bot shows while the person has its computer.
pub const PAUSED_FOR_YOU: &str = "Paused while you have the computer";

#[derive(Debug, thiserror::Error)]
pub enum TakeOverError {
    #[error("no such agent")]
    NotFound,
    #[error("this Spade has no computers")]
    Unavailable,
    #[error("{0}")]
    Failed(String),
}

impl Engine {
    /// Gives the engine the bots' computers. Call before work opens: a bot the person had when
    /// Spade stopped stays paused.
    pub fn set_computers(&self, computers: Arc<Computers>) {
        let _ = self.computers.set(computers);
    }

    pub fn computers(&self) -> Option<&Arc<Computers>> {
        self.computers.get()
    }

    /// Whether the person has the computer of the bot in `conversation`.
    /// Checked by the bot's id, so a record that could not be read still holds its bot.
    pub(super) fn held(&self, conversation: &str) -> bool {
        let Some(computers) = self.computers.get() else {
            return false;
        };
        if !computers.holds_any() {
            return false;
        }
        match self.agent_of(conversation) {
            Some(agent) => computers.driver(&agent) == crate::computer::Driver::Person,
            // No bot (a group's own conversation): there is no computer to hold.
            None => false,
        }
    }

    fn conversation_of_agent(&self, agent: &str) -> Result<String, TakeOverError> {
        match self.agent_view(agent) {
            Ok(Some(view)) => Ok(view.agent.conversation),
            Ok(None) => Err(TakeOverError::NotFound),
            Err(error) => Err(TakeOverError::Failed(error.to_string())),
        }
    }

    /// The person takes `agent`'s computer. Blocking (it notes the workspace's files); repeat
    /// calls change nothing.
    pub fn take_over(self: &Arc<Self>, agent: &str) -> Result<(), TakeOverError> {
        let computers = self.computers.get().ok_or(TakeOverError::Unavailable)?;
        let conversation = self.conversation_of_agent(agent)?;
        computers
            .take_over(agent, &conversation)
            .map_err(|e| TakeOverError::Failed(e.to_string()))?;
        self.live(&conversation).hold.send_replace(true);
        self.announce(&conversation);
        Ok(())
    }

    /// The person hands `agent`'s computer back: the note is stored first, so a crash before
    /// the release leaves the person driving (handing back again only adds a second note), then
    /// the bot carries on. Blocking; repeat calls change nothing.
    /// `handback` is what ace said the person did in the browser and screen, when it answered.
    pub fn hand_back(
        self: &Arc<Self>,
        agent: &str,
        handback: Option<&crate::computer::daemon::Handback>,
    ) -> Result<(), TakeOverError> {
        let computers = self.computers.get().ok_or(TakeOverError::Unavailable)?;
        let conversation = self.conversation_of_agent(agent)?;
        let Some(note) = computers.note(agent, handback) else {
            return Ok(());
        };
        self.record(
            &conversation,
            &Event::Known(Known::ComputerHandedBack {
                text: note.text,
                data: note.data,
            }),
        )
        .map_err(|e| TakeOverError::Failed(e.to_string()))?;
        computers
            .release(agent)
            .map_err(|e| TakeOverError::Failed(e.to_string()))?;
        self.live(&conversation).hold.send_replace(false);
        self.announce(&conversation);
        self.resume(&conversation)
            .map_err(|e| TakeOverError::Failed(e.to_string()))
    }

    /// What a new turn worker in `id` is told: Spade's own pause, or a pause at the next safe
    /// point while the person has the computer.
    pub(super) fn turn_pause(&self, id: &str, live: &Live) -> watch::Receiver<Pause> {
        live.hold.send_replace(self.held(id));
        let mut global = self.pause.subscribe();
        let mut hold = live.hold.subscribe();
        let effective = |pause: Pause, held: bool| match (pause, held) {
            (Pause::Off, true) => Pause::AfterStep,
            (pause, _) => pause,
        };
        let (tx, rx) = watch::channel(effective(
            *global.borrow_and_update(),
            *hold.borrow_and_update(),
        ));
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = tx.closed() => return,
                    changed = global.changed() => if changed.is_err() { return },
                    changed = hold.changed() => if changed.is_err() { return },
                }
                tx.send_replace(effective(
                    *global.borrow_and_update(),
                    *hold.borrow_and_update(),
                ));
            }
        });
        rx
    }

    /// A tool started in `conversation`: one of ace's browser or screen tools makes that surface
    /// of the bot's computer live.
    pub(super) fn computer_tool_started(&self, conversation: &str, name: &str) {
        let (Some(computers), Some(kind)) = (self.computers.get(), Kind::of_tool(name)) else {
            return;
        };
        if let Some(agent) = self.agent_of(conversation) {
            computers.bot_used(&agent, kind);
        }
    }

    /// Whether a paused turn in `id` may carry on now.
    pub(super) fn may_run(&self, id: &str) -> bool {
        *self.pause.borrow() == Pause::Off && !self.held(id)
    }
}
