//! `panel_update` (ADR 0200 §5.2): a packaged bot sets the state its package's panel shows. The
//! engine checks it against the panel's declared state schema and stores it for the calling
//! conversation; the page itself runs in its sandbox on the person's screen.

use serde_json::Value;
use spade_core::panel::{self, PANEL_UPDATE};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, TurnFacts};

/// What the model reads about `panel_update`.
const ABOUT: &str = "Set what one of your package's panels shows: the page beside your \
conversation that the person opens from your header. Send the panel's whole state as `data`, \
shaped as its state schema in your bot.json says; it replaces the last state. Data that doesn't \
fit is refused with every problem listed; fix them and set it again. What the person presses on \
the panel comes back to you as a <panel_action>. Only for a bot whose package ships a panel.";

/// `panel_update`, run by the engine for the calling conversation.
pub struct PanelUpdate(pub EngineHandle);

impl Tool for PanelUpdate {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: PANEL_UPDATE.to_owned(),
                description: ABOUT.to_owned(),
                schema: panel::tool_schema(),
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

    fn run_in(&self, key: &str, arguments: Value, _turn: &TurnFacts) -> ToolFuture {
        let engine = self.0.get();
        let agent = self.0.agent_for_key(key);
        let conversation = super::bots::caller(key).to_owned();
        let call_id = key.split_once('.').map_or(key, |(_, call)| call).to_owned();
        Box::pin(async move {
            let Some(engine) = engine else {
                return ToolOutput::error("Spade is stopping.");
            };
            engine.panel_update(&conversation, agent.as_deref(), &call_id, &arguments)
        })
    }
}
