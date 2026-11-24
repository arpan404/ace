//! A connected app's tool definitions, pinned per connection (ADR 0202, amendment 5). The first
//! time any of a connection's tools is used, Spade keeps a digest of the definition of every tool
//! the connection lists then (its own name, description and input schema). A tool whose
//! definition differs from the pinned one, or a tool that wasn't listed then (one renamed to look
//! like a read, say), loses its read and any Always allow until a call of it is approved, by the
//! reviewer or the person; then its definition is pinned. Kept in Spade's settings, so a restart
//! keeps them.

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
    /// Its connection's session generation now.
    pub generation: u64,
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
        self.app_call_with(conversation, &found, arguments)
    }

    /// [`Engine::app_call`] for the tool `found` as already looked up: one snapshot of it.
    pub(crate) fn app_call_with(
        &self,
        conversation: &str,
        found: &std::sync::Arc<dyn crate::tools::Tool>,
        arguments: &Value,
    ) -> Option<AppCall> {
        let (app, _) = found.app()?;
        found.definition()?;
        self.seed_pins(conversation, &app);
        self.pinned_app_call(found, arguments)
    }

    /// Read a binding without seeding pins during an unfinished step.
    pub(super) fn pinned_app_call(
        &self,
        found: &std::sync::Arc<dyn crate::tools::Tool>,
        arguments: &Value,
    ) -> Option<AppCall> {
        let tool = found.def().spec.name;
        let tool = tool.as_str();
        let (app, _) = found.app()?;
        let definition = found.definition()?;
        let changed = match self.store.setting(&key(&app, tool)) {
            Ok(Some(pinned)) => pinned != definition,
            // Not listed when the connection was first used: new since, so unproven. Unreadable:
            // read as changed too, so nothing rests on a pin Spade can't see.
            Ok(None) | Err(_) => true,
        };
        let reading = found.app_reading(arguments, changed)?;
        Some(AppCall {
            app,
            changed,
            generation: found.app_session().unwrap_or_default(),
            definition,
            reading,
        })
    }

    pub(super) fn has_app_pins(&self, app: &str) -> bool {
        matches!(
            self.store.setting(&format!("app_pins_seeded:{app}")),
            Ok(Some(_))
        )
    }

    /// On a connection's first use, pins every tool it lists then.
    fn seed_pins(&self, conversation: &str, app: &str) {
        let seeded = format!("app_pins_seeded:{app}");
        if !matches!(self.store.setting(&seeded), Ok(None)) {
            return;
        }
        for tool in self.tools.sourced_for(conversation) {
            if let (Some((of, _)), Some(definition)) = (tool.app(), tool.definition())
                && of == app
            {
                self.pin(app, &tool.def().spec.name, &definition);
            }
        }
        if let Err(error) = self.store.set_setting(&seeded, Some("1")) {
            tracing::warn!(%error, app, "an app's tool definitions couldn't be pinned");
        }
    }

    /// Binds the call `key` to what the gate approved it as, for its send.
    pub(crate) fn bind_app(&self, key: &str, call: &AppCall) {
        self.app_bindings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(
                key.to_owned(),
                spade_connect::Expect {
                    definition: call.definition.clone(),
                    generation: call.generation,
                },
            );
    }

    /// What the call `key` was approved as, taken: each approval sends once.
    pub(crate) fn take_app_binding(&self, key: &str) -> Option<spade_connect::Expect> {
        self.app_bindings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key)
    }

    /// Pins `definition` for `app`'s `tool`: on first use, or once a call of a changed one was
    /// approved.
    pub(crate) fn pin(&self, app: &str, tool: &str, definition: &str) {
        if let Err(error) = self.store.set_setting(&key(app, tool), Some(definition)) {
            tracing::warn!(%error, app, tool, "an app tool's definition couldn't be pinned");
        }
    }
}
