//! Cards (ADR 0200 §5.1): `card_show` stores a checked card in the bot's conversation as its own
//! row, and a choice the person presses on one reaches the bot once, like a job's result. The
//! rules are `spade_core::card`; this stores what they decide.

use std::sync::Arc;

use serde_json::Value;
use spade_core::Transcript;
use spade_core::card::{self, Refused};
use spade_core::event::{Event, ImageRef, Known};
use spade_store::StoreError;

use super::Engine;
use crate::tools::ToolOutput;

#[derive(Debug, thiserror::Error)]
pub enum CardError {
    #[error("no such conversation")]
    NotFound,
    #[error("{}", .0.words())]
    Refused(Refused),
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl Engine {
    /// Runs `card_show` for call `call_id` in `conversation`. `images` keeps an image block's
    /// workspace file and answers its stored bytes; it is called only for a card that fits.
    pub(crate) async fn card_show<F, Fut>(
        self: &Arc<Self>,
        conversation: &str,
        call_id: &str,
        arguments: &Value,
        untrusted: bool,
        images: F,
    ) -> ToolOutput
    where
        F: Fn(String) -> Fut,
        Fut: std::future::Future<Output = Result<ImageRef, String>>,
    {
        if self.is_helper(conversation) {
            return ToolOutput::error(
                "A helper can't show cards. Hand back what you found; the bot that started you \
                 can show it.",
            );
        }
        let events = match self.load(conversation) {
            Ok(events) => events,
            Err(error) => return ToolOutput::error(error.to_string()),
        };
        // Run again after a restart: the card it showed is the answer.
        if let Some(shown) = card::shown_by(&events, call_id) {
            return ToolOutput::ok(card::answer(shown));
        }
        let mut show = match card::read(&events, arguments) {
            Ok(show) => show,
            Err(problems) => return ToolOutput::error(card::refusal(&problems)),
        };
        let mut kept = Vec::new();
        let mut problems = Vec::new();
        // An `open` names a panel only of the bot's own package (ADR 0200 §5.2).
        let panels = self
            .agent_of(conversation)
            .and_then(|agent| self.bot_package(&agent))
            .map(|link| link.manifest.surfaces)
            .unwrap_or_default();
        for panel in show.card.panels() {
            if spade_core::package::surfaces::panel(&panels, panel).is_none() {
                problems.push(card::Problem {
                    at: format!("panel {panel}"),
                    why: "isn't one of your package's panels.".to_owned(),
                });
            }
        }
        for file in show.card.files() {
            match images(file.to_owned()).await {
                Ok(image) => kept.push(image),
                Err(why) => problems.push(card::Problem {
                    at: format!("image {file}"),
                    why,
                }),
            }
        }
        if !problems.is_empty() {
            return ToolOutput::error(card::refusal(&problems));
        }
        show.card.keep_images(kept.into_iter());
        let stored = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = match self.load(conversation) {
                Ok(events) => events,
                Err(error) => return ToolOutput::error(error.to_string()),
            };
            if let Some(shown) = card::shown_by(&events, call_id) {
                return ToolOutput::ok(card::answer(shown));
            }
            let reply = Transcript::fold(events.iter())
                .open_reply()
                .and_then(|message| message.reply.clone())
                .unwrap_or_default();
            let shown = card::shown(
                &events,
                &reply,
                call_id,
                &self.ids.next("card"),
                show,
                untrusted,
            );
            let answer = card::answer(&shown);
            match self.append(
                conversation,
                &Event::Known(Known::CardShown(Box::new(shown))),
            ) {
                Ok(_) => answer,
                Err(error) => return ToolOutput::error(error.to_string()),
            }
        };
        self.announce(conversation);
        ToolOutput::ok(stored)
    }

    /// The person pressed choice `action` on version `version` of card `card`: it reaches the bot
    /// once, steering its open reply or starting one.
    pub fn choose_on_card(
        self: &Arc<Self>,
        id: &str,
        card_id: &str,
        version: u32,
        action: &str,
    ) -> Result<(), CardError> {
        if !self.reachable(id)? {
            return Err(CardError::NotFound);
        }
        let event =
            card::choose(&self.load(id)?, card_id, version, action).map_err(CardError::Refused)?;
        // Checked again under the lock it is stored under, so two presses can't both land.
        match self.deliver_as(id, &Event::Known(event), None)? {
            spade_store::Delivered::Stored(_) => {
                self.announce(id);
                Ok(())
            }
            _ => Err(CardError::Refused(Refused::Chosen)),
        }
    }
}
