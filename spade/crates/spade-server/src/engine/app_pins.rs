//! A connected app's tool definitions, pinned per connection (ADR 0202, amendment 5). The first
//! time a tool is used, Spade keeps a digest of its definition as its server listed it (its own
//! name, description and input schema). A tool whose definition differs from the pinned one
//! (renamed to look like a read, say) loses its read and any Always allow until a call of it is
//! approved again, by the reviewer or the person; then the new definition is pinned. Kept in
//! Spade's settings, so a restart keeps them.

use serde_json::Value;
use spade_core::effect::AppReading;

use super::Engine;

/// A connected app's call as the gate reads it now.
pub(crate) struct AppCall {
    /// The connection's id.
    pub app: String,
    /// Its definition's digest now.
    pub definition: String,
    /// It differs from the one pinned for the tool.
    pub changed: bool,
    pub reading: AppReading,
}

fn key(app: &str, tool: &str) -> String {
    format!("app_pin:{app}:{tool}")
}

impl Engine {
    /// `tool` (as offered to `conversation`) read for this call, its definition pinned now if
    /// this is its first use. `None` for anything but a connected app's tool.
    pub(crate) fn app_call(
        &self,
        conversation: &str,
        tool: &str,
        arguments: &Value,
    ) -> Option<AppCall> {
        let found = self.tools.get_for(conversation, tool)?;
        let (app, _) = found.app()?;
        let definition = found.definition()?;
        let changed = match self.store.setting(&key(&app, tool)) {
            Ok(Some(pinned)) => pinned != definition,
            Ok(None) => {
                self.pin(&app, tool, &definition);
                false
            }
            // Unreadable: read as changed, so nothing rests on a pin Spade can't see.
            Err(_) => true,
        };
        let reading = found.app_reading(arguments, changed)?;
        Some(AppCall {
            app,
            definition,
            changed,
            reading,
        })
    }

    /// Pins `definition` for `app`'s `tool`: on first use, or once a call of a changed one was
    /// approved.
    pub(crate) fn pin(&self, app: &str, tool: &str, definition: &str) {
        if let Err(error) = self.store.set_setting(&key(app, tool), Some(definition)) {
            tracing::warn!(%error, app, tool, "an app tool's definition couldn't be pinned");
        }
    }
}
