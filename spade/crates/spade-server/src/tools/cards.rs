//! `card_show` (ADR 0200 §5.1): the bot shows the person a card drawn by ace from typed blocks,
//! never a page. The engine checks and stores it for the calling conversation.

use serde_json::Value;
use spade_core::card::{self, CARD_SHOW};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, TurnFacts};
use crate::workspace::Workspaces;

/// What the model reads about `card_show`.
const ABOUT: &str = "Show the person a card in this conversation, as its own row: a title and up \
to 12 blocks, drawn by ace. Use it for something with a shape (a fare that dropped, a status with \
numbers, a short table, choices to press), not for prose; your reply carries words. Blocks: \
fields (label and value rows), metric (one number with its unit and change), progress (value of \
max), table (columns and rows of text), list (short items), image (a file in your workspace), \
link (https, shown with its host) and actions: `choose` buttons whose label comes back to you \
once, as a <card_action>, and `open` buttons that open an https link or, with `panel`, one of \
your package's panels. To update a card in place \
(a fare ticking down), call card_show again with `replaces` and the card's id. A card that \
doesn't fit is refused with every problem listed; fix them and show it again.";

/// `card_show`, run by the engine for the calling conversation. `workspaces` lets image blocks
/// name a workspace file; without them an image block is refused.
pub struct CardShow {
    engine: EngineHandle,
    workspaces: Option<Workspaces>,
}

impl CardShow {
    pub fn new(engine: EngineHandle, workspaces: Option<Workspaces>) -> Self {
        Self { engine, workspaces }
    }
}

impl Tool for CardShow {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: CARD_SHOW.to_owned(),
                description: ABOUT.to_owned(),
                schema: card::schema(),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        self.run_in(key, arguments, &TurnFacts::default())
    }

    fn run_in(&self, key: &str, arguments: Value, turn: &TurnFacts) -> ToolFuture {
        let engine = self.engine.get();
        let conversation = super::bots::caller(key).to_owned();
        let call_id = key.split_once('.').map_or(key, |(_, call)| call).to_owned();
        let workspace = self
            .engine
            .agent_for_key(key)
            .zip(self.workspaces.clone())
            .and_then(|(bot, workspaces)| workspaces.of(&bot).ok());
        let untrusted = turn.untrusted.is_some();
        Box::pin(async move {
            let Some(engine) = engine else {
                return ToolOutput::error("Spade is stopping.");
            };
            let keeper = engine.clone();
            let images = move |file: String| {
                let (workspace, engine) = (workspace.clone(), keeper.clone());
                async move {
                    let workspace =
                        workspace.ok_or_else(|| "this bot has no workspace here.".to_owned())?;
                    let largest = crate::images::MOST_BYTES as u64;
                    let read =
                        tokio::task::spawn_blocking(move || workspace.bytes_up_to(&file, largest))
                            .await;
                    let bytes = match read {
                        Ok(Ok(bytes)) => bytes,
                        Ok(Err(error)) => return Err(error.to_string()),
                        Err(_) => return Err("it could not be read.".to_owned()),
                    };
                    if crate::images::sniff(&bytes).is_none() {
                        return Err("not an image (PNG, JPEG, GIF or WebP).".to_owned());
                    }
                    engine.put_image(&bytes).map_err(|error| error.to_string())
                }
            };
            engine
                .card_show(&conversation, &call_id, &arguments, untrusted, images)
                .await
        })
    }
}
