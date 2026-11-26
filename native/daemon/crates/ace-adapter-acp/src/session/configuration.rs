// SPDX-License-Identifier: Apache-2.0
//! Session-derived selectors and effective capabilities
//! (`packages/adapter-acp/src/configuration.ts`).
//!
//! Sans-IO: returns callback effects (`ConfigurationEffect`) instead of invoking closures,
//! and splits selection into `prepare_select` + `apply_select_reply`/`apply_select_error`.

use ace_json::{Map, Value};
use ace_supervisor::jsonrpc::error_code;
use thiserror::Error;

use super::mcp::McpTransport;
use super::negotiation::{
    CompatibilityProfile, Negotiated, NegotiationError, ProfileFit, negotiate, session_support,
};
use super::protocol::{METHOD_NOT_FOUND_CODE, agent_methods};
use super::quirks::AcpSessionQuirks;
use super::selectors::{
    SelectorKind, SelectorRequest, SelectorSpec, SelectorState, access_mode_offers,
    acp_permission_modes, selector_request, session_selectors,
};
use crate::translate::data::object;
use crate::translate::frame_redaction::{LEASE_REDACTION, redact_lease};

/// Callbacks emitted by [`AcpConfiguration`] as state changes.
#[derive(Debug, Clone, PartialEq)]
pub enum ConfigurationEffect {
    OnCapabilities { capabilities: Map, support: Map },
    OnSessionMetadata { raw: Value },
    OnPermissionMode { mode: String },
}

/// Errors raised during selector application (`configuration.ts:273`–`:291`).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SelectError {
    #[error("{0}")]
    Unavailable(String),
    #[error(
        "ACP model {requested} was not applied: the agent {} session/set_model, so it runs its own default model",
        if *.unsupported { "doesn't support" } else { "rejected" }
    )]
    LegacyModelRejected {
        requested: String,
        unsupported: bool,
    },
    #[error("ACP {} {requested} was not applied; the agent runs {running}", kind.as_str())]
    SelectorRefused {
        kind: SelectorKind,
        requested: String,
        running: String,
    },
    #[error("{0}")]
    Rpc(String),
}

/// Prepared selection waiting for its JSON-RPC reply.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingSelection {
    pub kind: SelectorKind,
    pub value: String,
    pub config_id: Option<String>,
    pub request: SelectorRequest,
}

/// Launch configuration metadata relevant to negotiation and selectors.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfigurationLaunch {
    pub version: Option<String>,
    pub profile: Option<CompatibilityProfile>,
    pub profile_fit: Option<ProfileFit>,
}

/// Session-derived selectors and effective capabilities (`configuration.ts:13`–`:206`).
#[derive(Debug)]
pub struct AcpConfiguration {
    pub capabilities: Option<Map>,
    pub support: Option<Map>,
    pub selectors: SelectorState,
    pub negotiated: Option<Negotiated>,
    quirks: AcpSessionQuirks,
    launch: ConfigurationLaunch,
    secrets: Vec<String>,
    /// The mode the session last reported, or ace last set; a change from it is announced.
    mode: Option<String>,
    /// Inside a selection: its caller decides what a moved mode means.
    quiet: bool,
    /// Off once the agent rejects `session/set_model`: no legacy model picker for the session.
    legacy_model: bool,
    last_mcp: McpTransport,
}

impl AcpConfiguration {
    pub fn new(
        quirks: AcpSessionQuirks,
        launch: ConfigurationLaunch,
        secrets: Vec<String>,
    ) -> Self {
        Self {
            capabilities: None,
            support: None,
            selectors: SelectorState::default(),
            negotiated: None,
            quirks,
            launch,
            secrets,
            mode: None,
            quiet: false,
            legacy_model: true,
            last_mcp: McpTransport::Unavailable,
        }
    }

    pub fn initialize(&mut self, raw: &Value) -> Result<&Negotiated, NegotiationError> {
        let negotiated = negotiate(
            raw,
            &self.quirks,
            self.launch.version.as_deref(),
            self.launch.profile.as_ref(),
            self.launch.profile_fit,
        )?;
        self.capabilities = Some(negotiated.capabilities.clone());
        self.negotiated = Some(negotiated);
        match self.negotiated.as_ref() {
            Some(neg) => Ok(neg),
            None => Err(NegotiationError::InvalidInitialize(
                "negotiated state missing".to_owned(),
            )),
        }
    }

    fn profile(&self) -> Option<&CompatibilityProfile> {
        match &self.negotiated {
            Some(neg) => neg.profile.as_ref(),
            None => self.launch.profile.as_ref(),
        }
    }

    /// Merge initial session setup, decode selectors, publish capabilities & metadata
    /// (`configuration.ts:54`–`:66`).
    pub fn setup(&mut self, raw: &Value, mcp: McpTransport) -> Vec<ConfigurationEffect> {
        let merged = merge_objects(&self.selectors.raw, &self.redact(raw));
        self.selectors = sendable(session_selectors(
            &merged,
            self.profile(),
            self.legacy_model,
        ));
        let mut effects = self.publish(mcp);
        self.mode = self.current(SelectorKind::Mode);
        effects.push(ConfigurationEffect::OnSessionMetadata {
            raw: self.selectors.raw.clone(),
        });
        effects
    }

    /// Apply a live `config_option_update` or selection reply (`configuration.ts:67`–`:77`).
    pub fn update(&mut self, raw: &Value) -> Vec<ConfigurationEffect> {
        let replacement = merge_objects(&self.selectors.raw, &self.redact(raw));
        self.selectors = sendable(session_selectors(
            &replacement,
            self.profile(),
            self.legacy_model,
        ));
        let mut effects = self.publish(self.last_mcp);
        effects.push(ConfigurationEffect::OnSessionMetadata {
            raw: self.selectors.raw.clone(),
        });
        self.mode_seen(&mut effects);
        effects
    }

    /// Handle `current_mode_update` (`configuration.ts:79`–`:83`).
    pub fn mode_changed(&mut self, mode_id: &str) -> Vec<ConfigurationEffect> {
        let mut modes = object(
            object(&self.selectors.raw)
                .get("modes")
                .unwrap_or(&Value::Null),
        )
        .clone();
        modes.insert("currentModeId", Value::from(mode_id));
        let mut patch = Map::with_capacity(1);
        patch.insert("modes", Value::Object(modes));
        self.update(&Value::Object(patch))
    }

    /// Emit `OnPermissionMode` if a current mode is known (`configuration.ts:85`–`:88`).
    pub fn announce_mode(&self) -> Option<ConfigurationEffect> {
        self.current(SelectorKind::Mode)
            .map(|mode| ConfigurationEffect::OnPermissionMode { mode })
    }

    fn mode_seen(&mut self, effects: &mut Vec<ConfigurationEffect>) {
        let Some(now) = self.current(SelectorKind::Mode) else {
            return;
        };
        if self.mode.as_deref() == Some(now.as_str()) {
            return;
        }
        self.mode = Some(now.clone());
        if !self.quiet {
            effects.push(ConfigurationEffect::OnPermissionMode { mode: now });
        }
    }

    /// Compute and emit `OnCapabilities` (`configuration.ts:95`–`:123`).
    pub fn publish(&mut self, mcp: McpTransport) -> Vec<ConfigurationEffect> {
        let Some(negotiated) = &self.negotiated else {
            return Vec::new();
        };
        self.last_mcp = mcp;
        let profile_id = self.profile().map(|p| p.id.as_str());
        let permission_modes =
            acp_permission_modes(&self.selectors.raw, self.quirks.provider(), profile_id);
        let mode_ids: Vec<String> = permission_modes
            .iter()
            .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect();
        let access_modes = access_mode_offers(self.quirks.provider(), profile_id, &mode_ids);

        let mut permissions = Map::with_capacity(4);
        permissions.insert(
            "modes",
            Value::Array(
                mode_ids
                    .iter()
                    .map(|id| Value::from(id.as_str()))
                    .collect::<Vec<_>>()
                    .into(),
            ),
        );
        permissions.insert(
            "permissionModes",
            Value::Array(permission_modes.clone().into()),
        );
        permissions.insert("nativeAutoReview", Value::Bool(false));
        permissions.insert("toolGate", Value::Bool(true));

        let plan_mode = self
            .selectors
            .mode
            .as_ref()
            .is_some_and(|spec| spec.values.iter().any(|v| v == "plan"));

        let mut caps = negotiated.capabilities.clone();
        caps.insert("permissionModes", Value::Array(permission_modes.into()));
        caps.insert("accessModes", Value::Array(access_modes.into()));
        caps.insert("permissions", Value::Object(permissions));
        caps.insert("planMode", Value::Bool(plan_mode));

        let coverage = if self.profile().is_some() {
            "source_profile"
        } else if self.quirks.provider() == "acp" {
            "generic"
        } else {
            "legacy"
        };
        let raw_redacted = self.redact(&negotiated.raw);
        let support = session_support(
            negotiated,
            &raw_redacted,
            self.selectors.model.is_some(),
            self.selectors.mode.is_some(),
            plan_mode,
            mcp,
            coverage,
        );

        self.capabilities = Some(caps.clone());
        self.support = Some(support.clone());
        vec![ConfigurationEffect::OnCapabilities {
            capabilities: caps,
            support,
        }]
    }

    /// Value the session last reported for `kind` (`configuration.ts:125`–`:142`).
    pub fn current(&self, kind: SelectorKind) -> Option<String> {
        let selector = self.selectors.get(kind)?;
        let raw = object(&self.selectors.raw);
        if let Some(config_id) = &selector.config_id {
            let options = raw.get("configOptions").and_then(Value::as_array)?;
            let entry = options.iter().find(|option| {
                object(option).get("id").and_then(Value::as_str) == Some(config_id.as_str())
            })?;
            return object(entry)
                .get("currentValue")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        let field = match kind {
            SelectorKind::Mode => object(raw.get("modes").unwrap_or(&Value::Null))
                .get("currentModeId")
                .and_then(Value::as_str),
            SelectorKind::Model => object(raw.get("models").unwrap_or(&Value::Null))
                .get("currentModelId")
                .and_then(Value::as_str),
            SelectorKind::Effort => None,
        };
        field.map(str::to_owned)
    }

    /// Step 1 of `select`: validate `value` against listed selectors and build the RPC request.
    pub fn prepare_select(
        &self,
        kind: SelectorKind,
        value: &str,
        session_id: &str,
    ) -> Result<PendingSelection, SelectError> {
        let request = selector_request(&self.selectors, kind, value, session_id)
            .map_err(SelectError::Unavailable)?;
        let config_id = self
            .selectors
            .get(kind)
            .and_then(|spec| spec.config_id.clone());
        Ok(PendingSelection {
            kind,
            value: value.to_owned(),
            config_id,
            request,
        })
    }

    /// Step 2a of `select`: handle an RPC error from the selection request (`configuration.ts:157`–`:162`).
    pub fn apply_select_error(
        &mut self,
        pending: &PendingSelection,
        error_message: &str,
    ) -> (Vec<ConfigurationEffect>, SelectError) {
        if pending.request.method != agent_methods::SESSION_SET_MODEL {
            return (Vec::new(), SelectError::Rpc(error_message.to_owned()));
        }
        let Some(code) = error_code(error_message) else {
            return (Vec::new(), SelectError::Rpc(error_message.to_owned()));
        };
        self.legacy_model = false;
        let effects = self.update(&Value::Object(Map::new()));
        (
            effects,
            SelectError::LegacyModelRejected {
                requested: pending.value.clone(),
                unsupported: code == METHOD_NOT_FOUND_CODE as f64,
            },
        )
    }

    /// Step 2b of `select`: apply a successful selection reply and verify the running value
    /// (`configuration.ts:163`–`:183`).
    pub fn apply_select_reply(
        &mut self,
        pending: &PendingSelection,
        result: &Value,
    ) -> (Vec<ConfigurationEffect>, Result<(), SelectError>) {
        let reply = object(result);
        let listed = object(reply.get("models").unwrap_or(&Value::Null));
        let named = named_current(reply, pending.kind, pending.config_id.as_deref());
        self.quiet = true;
        if pending.kind == SelectorKind::Mode {
            self.mode = Some(pending.value.clone());
        }
        let mut effects = if reply.get("configOptions").is_some_and(Value::is_array) {
            self.update(result)
        } else if pending.kind == SelectorKind::Model
            && listed
                .get("currentModelId")
                .and_then(Value::as_str)
                .is_some()
        {
            let existing = object(
                object(&self.selectors.raw)
                    .get("models")
                    .unwrap_or(&Value::Null),
            );
            let mut merged_models = existing.clone();
            for (k, v) in listed.iter() {
                merged_models.insert(k.clone(), v.clone());
            }
            let mut patch = Map::with_capacity(1);
            patch.insert("models", Value::Object(merged_models));
            self.update(&Value::Object(patch))
        } else {
            self.assume(pending.kind, &pending.value)
        };
        self.quiet = false;

        let now = named.or_else(|| self.current(pending.kind));
        if let Some(running) = now
            && running != pending.value
        {
            if pending.kind == SelectorKind::Mode
                && let Some(effect) = self.announce_mode()
            {
                effects.push(effect);
            }
            return (
                effects,
                Err(SelectError::SelectorRefused {
                    kind: pending.kind,
                    requested: pending.value.clone(),
                    running,
                }),
            );
        }
        (effects, Ok(()))
    }

    fn assume(&mut self, kind: SelectorKind, value: &str) -> Vec<ConfigurationEffect> {
        let Some(selector) = self.selectors.get(kind).cloned() else {
            return Vec::new();
        };
        let raw = object(&self.selectors.raw);
        if let Some(config_id) = selector.config_id {
            let options = raw
                .get("configOptions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let updated: Vec<Value> = options
                .into_iter()
                .map(|option| {
                    if object(&option).get("id").and_then(Value::as_str) == Some(config_id.as_str())
                    {
                        let mut copy = object(&option).clone();
                        copy.insert("currentValue", Value::from(value));
                        Value::Object(copy)
                    } else {
                        option
                    }
                })
                .collect();
            let mut patch = Map::with_capacity(1);
            patch.insert("configOptions", Value::Array(updated.into()));
            self.update(&Value::Object(patch))
        } else if kind == SelectorKind::Mode {
            let mut modes = object(raw.get("modes").unwrap_or(&Value::Null)).clone();
            modes.insert("currentModeId", Value::from(value));
            let mut patch = Map::with_capacity(1);
            patch.insert("modes", Value::Object(modes));
            self.update(&Value::Object(patch))
        } else if kind == SelectorKind::Model {
            let mut models = object(raw.get("models").unwrap_or(&Value::Null)).clone();
            models.insert("currentModelId", Value::from(value));
            let mut patch = Map::with_capacity(1);
            patch.insert("models", Value::Object(models));
            self.update(&Value::Object(patch))
        } else {
            Vec::new()
        }
    }

    fn redact(&self, raw: &Value) -> Value {
        redact_lease(raw, &self.secrets)
    }
}

fn merge_objects(base: &Value, patch: &Value) -> Value {
    let mut out = object(base).clone();
    for (key, value) in object(patch).iter() {
        out.insert(key.clone(), value.clone());
    }
    Value::Object(out)
}

fn clean_values(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter(|value| !value.contains(LEASE_REDACTION))
        .collect()
}

fn sendable_spec(spec: SelectorSpec) -> SelectorSpec {
    SelectorSpec {
        config_id: spec.config_id,
        method: spec.method,
        values: clean_values(spec.values),
    }
}

fn sendable(selectors: SelectorState) -> SelectorState {
    SelectorState {
        model: selectors.model.map(sendable_spec),
        mode: selectors.mode.map(sendable_spec),
        effort: selectors.effort.map(sendable_spec),
        raw: selectors.raw,
    }
}

fn config_kinds(kind: SelectorKind) -> &'static [&'static str] {
    match kind {
        SelectorKind::Model => &["model"],
        SelectorKind::Mode => &["mode", "permission", "permissions"],
        SelectorKind::Effort => &["thought_level", "reasoning_effort"],
    }
}

/// Value a selection reply names as running now for `kind` (`configuration.ts:242`–`:267`).
fn named_current(reply: &Map, kind: SelectorKind, config_id: Option<&str>) -> Option<String> {
    let kinds = config_kinds(kind);
    if let Some(options) = reply.get("configOptions").and_then(Value::as_array) {
        for option in options {
            let entry = object(option);
            let id = entry.get("id").and_then(Value::as_str);
            let category = entry.get("category").and_then(Value::as_str);
            let matches = (config_id.is_some() && id == config_id)
                || match category {
                    Some(cat) => kinds.contains(&cat),
                    None => id.is_some_and(|i| kinds.contains(&i)),
                };
            if matches && let Some(value) = entry.get("currentValue").and_then(Value::as_str) {
                return Some(value.to_owned());
            }
        }
    }
    let legacy = match kind {
        SelectorKind::Model => object(reply.get("models").unwrap_or(&Value::Null))
            .get("currentModelId")
            .and_then(Value::as_str),
        SelectorKind::Mode => object(reply.get("modes").unwrap_or(&Value::Null))
            .get("currentModeId")
            .and_then(Value::as_str),
        SelectorKind::Effort => None,
    };
    legacy.map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::{AcpConfiguration, ConfigurationLaunch, SelectError};
    use crate::session::mcp::McpTransport;
    use crate::session::quirks::AcpSessionQuirks;
    use crate::session::selectors::SelectorKind;
    use ace_json::{Value, json};

    fn configured(secrets: Vec<String>) -> AcpConfiguration {
        let mut config = AcpConfiguration::new(
            AcpSessionQuirks::generic(),
            ConfigurationLaunch::default(),
            secrets,
        );
        if let Err(err) = config.initialize(&json!({ "protocolVersion": 1 })) {
            panic!("initialize failed: {err}");
        }
        config
    }

    fn legacy_models() -> Value {
        json!({
            "models": {
                "availableModels": [{ "modelId": "model-a" }, { "modelId": "model-b" }],
                "currentModelId": "model-a"
            }
        })
    }

    // Class (b) tests moved from `packages/adapter-acp/src/configuration.test.ts`:

    #[test]
    fn reply_emptying_options_but_naming_another_current_model_did_not_apply_selection() {
        let mut config = configured(Vec::new());
        config.setup(&legacy_models(), McpTransport::Unavailable);
        let Ok(pending) = config.prepare_select(SelectorKind::Model, "model-b", "s") else {
            panic!("expected prepare_select to succeed");
        };
        let (_, res) = config.apply_select_reply(
            &pending,
            &json!({ "configOptions": [], "models": { "currentModelId": "model-a" } }),
        );
        assert_eq!(
            res.err().map(|e| e.to_string()),
            Some("ACP model model-b was not applied; the agent runs model-a".to_owned())
        );
    }

    #[test]
    fn reply_whose_model_option_names_another_value_did_not_apply_selection() {
        let mut config = configured(Vec::new());
        config.setup(
            &json!({
                "configOptions": [{
                    "id": "model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "model-a",
                    "options": [{ "value": "model-a" }, { "value": "model-b" }]
                }]
            }),
            McpTransport::Unavailable,
        );
        let Ok(pending) = config.prepare_select(SelectorKind::Model, "model-b", "s") else {
            panic!("expected prepare_select to succeed");
        };
        let (_, res) = config.apply_select_reply(
            &pending,
            &json!({
                "configOptions": [{
                    "id": "model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "model-a"
                }]
            }),
        );
        assert!(
            res.err()
                .is_some_and(|e| e.to_string().contains("not applied"))
        );
    }

    #[test]
    fn reply_naming_the_requested_model_applies_it() {
        let mut config = configured(Vec::new());
        config.setup(&legacy_models(), McpTransport::Unavailable);
        let Ok(pending) = config.prepare_select(SelectorKind::Model, "model-b", "s") else {
            panic!("expected prepare_select to succeed");
        };
        let (_, res) = config.apply_select_reply(
            &pending,
            &json!({ "configOptions": [], "models": { "currentModelId": "model-b" } }),
        );
        assert_eq!(res, Ok(()));
    }

    #[test]
    fn model_id_changed_by_lease_redaction_is_never_sent_though_setup_shows_it_redacted() {
        let secret = "lease-secret-1234".to_owned();
        let mut config = configured(vec![secret.clone()]);
        config.setup(
            &json!({
                "models": {
                    "availableModels": [
                        { "modelId": format!("model-{secret}") },
                        { "modelId": "model-b" }
                    ],
                    "currentModelId": "model-b"
                }
            }),
            McpTransport::Unavailable,
        );
        let raw_json = config.selectors.raw.to_json();
        assert!(raw_json.contains("model-[ace lease redacted]"));
        assert!(!raw_json.contains(&secret));

        let redacted_err =
            config.prepare_select(SelectorKind::Model, "model-[ace lease redacted]", "s");
        assert!(
            redacted_err
                .err()
                .is_some_and(|e| e.to_string().contains("selection unavailable"))
        );

        let raw_secret_err =
            config.prepare_select(SelectorKind::Model, &format!("model-{secret}"), "s");
        assert!(
            raw_secret_err
                .err()
                .is_some_and(|e| e.to_string().contains("selection unavailable"))
        );

        let Ok(pending) = config.prepare_select(SelectorKind::Model, "model-b", "s") else {
            panic!("expected model-b selection to prepare");
        };
        assert_eq!(pending.request.method, "session/set_model");
        assert_eq!(
            Value::Object(pending.request.params.clone()),
            json!({ "sessionId": "s", "modelId": "model-b" })
        );
    }

    #[test]
    fn legacy_model_rejection_disables_legacy_picker_for_rest_of_session() {
        let mut config = configured(Vec::new());
        config.setup(&legacy_models(), McpTransport::Unavailable);
        let Ok(pending) = config.prepare_select(SelectorKind::Model, "model-b", "s") else {
            panic!("expected prepare_select");
        };
        let (_, err) =
            config.apply_select_error(&pending, r#"{"code":-32601,"message":"Method not found"}"#);
        assert_eq!(
            err,
            SelectError::LegacyModelRejected {
                requested: "model-b".to_owned(),
                unsupported: true,
            }
        );
        assert!(config.selectors.model.is_none());
        assert!(
            config
                .prepare_select(SelectorKind::Model, "model-b", "s")
                .is_err()
        );
    }
}
