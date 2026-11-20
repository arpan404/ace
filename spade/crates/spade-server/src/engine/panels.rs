//! Panels (ADR 0200 §5.2): `panel_update` stores a packaged bot's panel state, checked against
//! the schema its package declared, and an action the person sends from a panel reaches the bot
//! once, as their input. The rules are `spade_core::panel`; this stores what they decide.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use spade_core::event::{Event, Known};
use spade_core::package::surfaces::{self, Surface};
use spade_core::panel::{self, Refused};
use spade_store::StoreError;

use super::Engine;
use crate::tools::ToolOutput;

#[derive(Debug, thiserror::Error)]
pub enum PanelError {
    #[error("no such conversation")]
    NotFound,
    #[error("{}", .0.words())]
    Refused(Refused),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// One of a bot's panels, as clients open it: what it declares, the page it shows, its state.
#[derive(Debug, Clone, Serialize)]
pub struct PanelView {
    pub id: String,
    pub title: String,
    /// The sha256 of its page, served by `GET /v1/panels/pages/{hash}`; none until one arrived.
    pub page: Option<String>,
    /// The actions its page may send, by name.
    pub actions: Vec<String>,
    /// The latest state its bot set, if any.
    pub state: Option<Value>,
}

impl Engine {
    /// What bot `agent`'s package ships, if it is packaged.
    fn surfaces_of(&self, agent: &str) -> Vec<Surface> {
        self.bot_package(agent)
            .map(|link| link.manifest.surfaces)
            .unwrap_or_default()
    }

    /// Runs `panel_update` for call `call_id` in `conversation`, a call of bot `agent`.
    pub(crate) fn panel_update(
        self: &Arc<Self>,
        conversation: &str,
        agent: Option<&str>,
        call_id: &str,
        arguments: &Value,
    ) -> ToolOutput {
        if self.is_helper(conversation) {
            return ToolOutput::error(
                "A helper can't set panels. Hand back what you found; the bot that started you \
                 can set its panel.",
            );
        }
        let surfaces = agent.map(|a| self.surfaces_of(a)).unwrap_or_default();
        let (panel, data) = match panel::read_update(&surfaces, arguments) {
            Ok(read) => read,
            Err(problems) => return ToolOutput::error(panel::refusal(&problems)),
        };
        let answer = panel::updated(panel);
        let stored = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = match self.load(conversation) {
                Ok(events) => events,
                Err(error) => return ToolOutput::error(error.to_string()),
            };
            // Run again after a restart: the state it set is the answer.
            if panel::updated_by(&events, call_id) {
                return ToolOutput::ok(answer);
            }
            self.append(
                conversation,
                &Event::Known(Known::PanelUpdated {
                    surface: panel.id.clone(),
                    call_id: call_id.to_owned(),
                    data,
                }),
            )
        };
        if let Err(error) = stored {
            return ToolOutput::error(error.to_string());
        }
        self.announce(conversation);
        ToolOutput::ok(answer)
    }

    /// The bot whose conversation `id` is, with its surfaces.
    fn panels_for(&self, id: &str) -> Result<(String, Vec<Surface>), PanelError> {
        if !self.reachable(id)? {
            return Err(PanelError::NotFound);
        }
        let agent = self.agent_of(id).ok_or(PanelError::NotFound)?;
        let surfaces = self.surfaces_of(&agent);
        Ok((agent, surfaces))
    }

    /// The panels of the bot whose conversation `id` is, with each one's page and latest state.
    pub fn panels(&self, id: &str) -> Result<Vec<PanelView>, PanelError> {
        let (agent, surfaces) = self.panels_for(id)?;
        let pages = crate::packages::panels::hashes(self, &agent);
        let events = self.load(id)?;
        Ok(surfaces::panels(&surfaces)
            .map(|declared| PanelView {
                id: declared.id.clone(),
                title: declared.title.clone(),
                page: pages.get(&declared.id).cloned(),
                actions: declared.actions.iter().map(|a| a.name.clone()).collect(),
                state: panel::state(&events, &declared.id).cloned(),
            })
            .collect())
    }

    /// The person sent action `action` with `value` from panel `surface` in conversation `id`, as
    /// request `key`: it reaches the bot once, steering its open reply or starting one. Only an
    /// action the panel declares, with a value that fits its schema, gets through.
    pub fn act_on_panel(
        self: &Arc<Self>,
        id: &str,
        surface: &str,
        key: &str,
        action: &str,
        value: Option<Value>,
    ) -> Result<(), PanelError> {
        let (_, surfaces) = self.panels_for(id)?;
        let event =
            panel::act(&surfaces, surface, key, action, value).map_err(PanelError::Refused)?;
        // Checked again under the lock it is stored under, so a request sent twice lands once.
        if let spade_store::Delivered::Stored(_) =
            self.deliver_as(id, &Event::Known(event), None)?
        {
            self.announce(id);
        }
        Ok(())
    }
}
