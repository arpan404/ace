//! Panels (ADR 0200 §5.2): `panel_update` stores a packaged bot's panel state, checked against
//! the schema its package declared, and an action sent from a panel reaches the bot once: as its
//! page's untrusted input, or as the person's when they confirmed it in ace (amendment 1). The
//! rules are `spade_core::panel`; this stores what they decide.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{Value, json};
use spade_core::event::{Event, Known, PanelSender};
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
    /// Those only the person may send, with the words ace's confirm shows for each.
    pub confirm: Vec<ConfirmView>,
    /// The latest state its bot set, if any; an app's panel's is its tool's input and result.
    pub state: Option<Value>,
    /// For an MCP app's page (ADR 0202 §4), its app: name, tool, page address, its tools and
    /// whether each is offered to the page, why it isn't drawn, and what it asked for and didn't
    /// get. `None` for a package's panel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<Value>,
}

/// Kept pages one batch of the collection looks at, in one short transaction.
const COLLECT_BATCH: usize = 64;

/// An action ace asks the person to confirm before it goes, in their own words.
#[derive(Debug, Clone, Serialize)]
pub struct ConfirmView {
    pub name: String,
    pub label: String,
}

impl Engine {
    /// Removes the kept panel pages no bot's panels show any more (an uninstalled bot's, a
    /// version an update replaced, a move's that left or never took), `COLLECT_BATCH` at a time,
    /// each batch its own transaction, so other writes go on between them. Runs off the async
    /// threads from the hourly sweep, never at start (ADR 0170). Answers how many it removed.
    pub fn collect_panel_pages(&self) -> usize {
        let mut after: Option<String> = None;
        let mut removed = 0;
        loop {
            match self
                .store
                .collect_panel_pages(after.as_deref(), COLLECT_BATCH)
            {
                Ok(batch) => {
                    removed += batch.removed;
                    match batch.next {
                        Some(next) => after = Some(next),
                        None => return removed,
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "unused panel pages could not be collected yet");
                    return removed;
                }
            }
        }
    }

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
        let mut views: Vec<PanelView> = surfaces::panels(&surfaces)
            .map(|declared| PanelView {
                id: declared.id.clone(),
                title: declared.title.clone(),
                page: pages.get(&declared.id).cloned(),
                actions: declared.actions.iter().map(|a| a.name.clone()).collect(),
                confirm: declared
                    .actions
                    .iter()
                    .filter(|a| a.confirm)
                    .map(|a| ConfirmView {
                        name: a.name.clone(),
                        label: a.label.clone().unwrap_or_else(|| a.name.clone()),
                    })
                    .collect(),
                state: panel::state(&events, &declared.id).cloned(),
                app: None,
            })
            .collect();
        // Pages of the apps the bot used, beside its package's (ADR 0202 §4).
        views.extend(Self::app_panels(&events).into_iter().map(|(id, data)| {
            PanelView {
                title: data["app"]["name"].as_str().unwrap_or("App").to_owned(),
                page: data["app"]["page"].as_str().map(str::to_owned),
                actions: [
                    spade_core::app_page::TOOLS_CALL,
                    spade_core::app_page::MESSAGE,
                    spade_core::app_page::MODEL_CONTEXT,
                ]
                .map(str::to_owned)
                .to_vec(),
                confirm: Vec::new(),
                state: Some(json!({ "input": data["input"], "result": data["result"] })),
                app: Some(data["app"].clone()),
                id,
            }
        }));
        Ok(views)
    }

    /// Action `action` with `value` came from panel `surface` in conversation `id`, sent `by` its
    /// page or the person, as request `key`: it reaches the bot once, steering its open reply or
    /// starting one. Only an action the panel declares, with a value that fits its schema, gets
    /// through, and one it declares `confirm` only when the person confirmed it.
    pub fn act_on_panel(
        self: &Arc<Self>,
        id: &str,
        surface: &str,
        key: &str,
        action: &str,
        value: Option<Value>,
        by: PanelSender,
    ) -> Result<(), PanelError> {
        let (_, surfaces) = self.panels_for(id)?;
        if spade_core::app_page::is_app_panel(surface) {
            return self.act_on_app_panel(id, surface, key, action, value, by);
        }
        let event =
            panel::act(&surfaces, surface, key, action, value, by).map_err(PanelError::Refused)?;
        // Checked again under the lock it is stored under, so a request sent twice lands once.
        if let spade_store::Delivered::Stored(_) =
            self.deliver_as(id, &Event::Known(event), None)?
        {
            self.announce(id);
        }
        Ok(())
    }
}
