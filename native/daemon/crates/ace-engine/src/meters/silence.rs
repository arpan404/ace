// SPDX-License-Identifier: Apache-2.0
//! `silence.ts`: the unresponsive threshold a thread's status runs under, resolved across the
//! global setting, a workspace's override and the thread's own explicit value.

use ace_json::Value;

use crate::EngineError;
use crate::futures::future::LocalBoxFuture;

/// `SettingsValues["threads.unresponsiveAfter"]`'s default (`packages/settings`): 5 minutes, so a
/// silently thinking agent stays working past a minute.
pub const DEFAULT_SILENCE_MS: f64 = 5.0 * 60_000.0;

/// `workspaceOf(id)`: the workspace a thread belongs to, when it still has one.
pub type WorkspaceOf = Box<dyn Fn(&str) -> Option<String>>;

/// `unresponsiveAfterMs`: the three offered durations.
pub fn unresponsive_after_ms(value: &str) -> Option<f64> {
    match value {
        "2m" => Some(120_000.0),
        "5m" => Some(300_000.0),
        "15m" => Some(900_000.0),
        _ => None,
    }
}

/// `parseSilenceMs`: a stored setting's duration, else `fallback`.
pub fn parse_silence_ms(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(|value| match value {
            Value::String(text) => Some(text.as_str()),
            _ => None,
        })
        .and_then(unresponsive_after_ms)
        .unwrap_or(fallback)
}

/// `validSilenceMs`: a whole, non-negative number, or a refusal (the option is invalid).
pub fn valid_silence_ms(ms: f64) -> Result<f64, EngineError> {
    if ms.is_finite() && ms.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&ms) {
        return Ok(ms);
    }
    Err(EngineError::Port(crate::ports::PortError::Threw(
        "Invalid silenceMs".to_owned(),
    )))
}

/// The scope `options.resolveSilenceMs` is asked about.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SilenceScope {
    pub thread_id: Option<String>,
    pub workspace_id: Option<String>,
}

/// `resolveSilenceMs(scope)`: the setting that applies, or `None` when nothing overrides.
pub trait SilenceResolver {
    fn resolve(&self, scope: SilenceScope) -> LocalBoxFuture<'static, Result<Option<f64>, String>>;
}

/// `SilenceThresholds`: the global default, each workspace's override, and the thread lookup that
/// feeds them.
pub struct SilenceThresholds {
    default_ms: f64,
    workspace_ms: std::collections::HashMap<String, f64>,
    resolver: Option<std::rc::Rc<dyn SilenceResolver>>,
    workspace_of: WorkspaceOf,
}

impl SilenceThresholds {
    pub fn new(
        initial_ms: Option<f64>,
        resolver: Option<std::rc::Rc<dyn SilenceResolver>>,
        workspace_of: WorkspaceOf,
    ) -> Result<SilenceThresholds, EngineError> {
        Ok(SilenceThresholds {
            default_ms: valid_silence_ms(initial_ms.unwrap_or(DEFAULT_SILENCE_MS))?,
            workspace_ms: std::collections::HashMap::new(),
            resolver,
            workspace_of,
        })
    }

    /// `forWorkspace`: the workspace's setting, else the global one.
    pub fn for_workspace(&self, workspace_id: Option<&str>) -> f64 {
        workspace_id
            .and_then(|id| self.workspace_ms.get(id).copied())
            .unwrap_or(self.default_ms)
    }

    pub fn default_ms(&self) -> f64 {
        self.default_ms
    }

    /// `setDefault`: a new global default drops every cached workspace override.
    pub fn set_default(&mut self, ms: f64) -> Result<(), EngineError> {
        self.default_ms = valid_silence_ms(ms)?;
        self.workspace_ms.clear();
        Ok(())
    }

    pub fn clear_workspace(&mut self, workspace_id: Option<&str>) {
        match workspace_id {
            Some(id) => {
                self.workspace_ms.remove(id);
            }
            None => self.workspace_ms.clear(),
        }
    }

    /// `prepareGlobal()`: the setting that applies to new and recovered threads.
    pub async fn prepare_global(&mut self) -> Result<(), EngineError> {
        let Some(resolver) = self.resolver.clone() else {
            return Ok(());
        };
        if let Some(resolved) = resolver
            .resolve(SilenceScope::default())
            .await
            .map_err(|message| EngineError::Port(crate::ports::PortError::Threw(message)))?
        {
            self.set_default(resolved)?;
        }
        Ok(())
    }

    pub async fn prepare_workspace(&mut self, workspace_id: &str) -> Result<(), EngineError> {
        let Some(resolver) = self.resolver.clone() else {
            return Ok(());
        };
        if let Some(resolved) = resolver
            .resolve(SilenceScope {
                thread_id: None,
                workspace_id: Some(workspace_id.to_owned()),
            })
            .await
            .map_err(|message| EngineError::Port(crate::ports::PortError::Threw(message)))?
        {
            self.workspace_ms
                .insert(workspace_id.to_owned(), valid_silence_ms(resolved)?);
        }
        Ok(())
    }

    /// `syncThread(id, apply)`: the thread's own setting, applied through the caller's hook.
    pub async fn sync_thread(
        &self,
        id: &str,
        apply: impl Fn(&str, f64),
    ) -> Result<(), EngineError> {
        let Some(resolver) = self.resolver.clone() else {
            return Ok(());
        };
        let workspace_id = (self.workspace_of)(id);
        let resolved = resolver
            .resolve(SilenceScope {
                thread_id: Some(id.to_owned()),
                workspace_id,
            })
            .await
            .map_err(|message| EngineError::Port(crate::ports::PortError::Threw(message)))?;
        if let Some(resolved) = resolved {
            apply(id, valid_silence_ms(resolved)?);
        }
        Ok(())
    }

    /// `prepareCommand`: a create or prepare settles its workspace's setting; a send, resume,
    /// queue resume, limit resume or fork re-syncs the thread's.
    pub async fn prepare_command(
        &mut self,
        command: &Value,
        apply: impl Fn(&str, f64),
    ) -> Result<(), EngineError> {
        if self.resolver.is_none() {
            return Ok(());
        }
        let payload = command.get("payload").unwrap_or(&Value::Null);
        let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "thread.create" | "thread.prepare" => {
                if let Some(workspace) = payload.get("workspaceId").and_then(Value::as_str) {
                    self.prepare_workspace(workspace).await?;
                }
            }
            "thread.send" | "thread.resume" | "queue.resume" | "thread.limit" | "thread.fork" => {
                if let Some(id) = payload.get("threadId").and_then(Value::as_str) {
                    self.sync_thread(id, apply).await?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}
