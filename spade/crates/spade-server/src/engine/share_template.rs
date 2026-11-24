//! Reuse the card event for placement and replay. The draft's bytes live in local storage.

use spade_core::Transcript;
use spade_core::card::{self, Block, Card, Field, Show};
use spade_core::event::{Event, Known};

use super::Engine;
use crate::teams::share_template::Draft;

impl Engine {
    pub(crate) fn keep_share_template(
        &self,
        conversation: &str,
        call: &str,
        draft: &Draft,
    ) -> Result<String, String> {
        let id = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if !self.share_source_live(&draft.bot) {
                return Err("The source bot was deleted.".to_owned());
            }
            let events = self.load(conversation).map_err(|e| e.to_string())?;
            if let Some(shown) = card::shown_by(&events, call) {
                return Ok(shown.card.clone());
            }
            let reply = Transcript::fold(events.iter())
                .open_reply()
                .and_then(|message| message.reply.clone())
                .ok_or("A template needs an open conversation reply.")?;
            let id = self.ids.next("template");
            let data = serde_json::to_string(draft).map_err(|e| e.to_string())?;
            if data.len() > 512 * 1024 {
                return Err(
                    "The template is too large. Choose fewer skills, notes or routines.".to_owned(),
                );
            }
            self.store()
                .set_setting(&Draft::key(&id), Some(&data))
                .map_err(|e| e.to_string())?;
            let shown = card::shown(
                &events,
                &reply,
                call,
                &id,
                Show {
                    card: Card {
                        title: draft.recipe["name"].as_str().unwrap_or_default().to_owned(),
                        blocks: vec![Block::Fields {
                            rows: vec![Field {
                                label: "Description".to_owned(),
                                value: draft.recipe["blurb"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .to_owned(),
                            }],
                        }],
                    },
                    replaces: None,
                    surface: None,
                },
                false,
            );
            if let Err(error) = self.append(
                conversation,
                &Event::Known(Known::CardShown(Box::new(shown))),
            ) {
                let _ = self.store().set_setting(&Draft::key(&id), None);
                return Err(error.to_string());
            }
            id
        };
        self.announce(conversation);
        Ok(id)
    }

    pub(crate) fn share_source_live(&self, id: &str) -> bool {
        self.store()
            .agent(id)
            .is_ok_and(|agent| agent.is_some_and(|agent| !self.deleting(&agent.conversation)))
    }

    pub(crate) fn share_template_write<T>(&self, write: impl FnOnce() -> T) -> T {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        write()
    }

    pub(crate) fn share_template(&self, id: &str) -> Result<Option<Draft>, String> {
        self.store()
            .setting(&Draft::key(id))
            .map_err(|e| e.to_string())?
            .map(|data| serde_json::from_str(&data).map_err(|e| e.to_string()))
            .transpose()
    }
}
