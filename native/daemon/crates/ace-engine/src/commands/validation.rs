// SPDX-License-Identifier: Apache-2.0
//! `creation-validation.ts` (E5.4e): the shared admission decision, in its order, with the
//! filesystem, registry and catalog reads supplied through [`CreationFacts`].

use ace_json::Value;

/// The largest message a create may carry (`maxMessageBytes`).
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
/// The most parts one message may carry.
const MAX_PARTS: usize = 64;

/// What validation reads from the engine and its edges.
pub trait CreationFacts {
    fn thread_exists(&self, id: &str) -> bool;
    fn workspace(&self, id: &str) -> Option<String>;
    fn directory(&self, path: &str) -> Option<String>;
    fn reserved(&self, root: &str) -> bool;
    /// `registry.has(provider, acpIdentity)`: an adapter, and for ACP that exact agent.
    fn has_provider(&self, provider: &str, acp_identity: Option<&Value>) -> bool;
    /// The adapter's native transport, for the Cursor SDK budget and the cursor id mapping.
    fn backend(&self, provider: &str) -> Option<String>;
    /// `models.permissionCapabilities(provider, instanceId, entry.capabilities)`.
    fn permission_capabilities(
        &self,
        provider: &str,
        instance_id: Option<&str>,
        base: &Value,
    ) -> Value;
    /// The access modes an instance offers, when its capabilities report any.
    fn access_offers(&self, provider: &str, capabilities: &Value) -> Option<Vec<String>>;
    fn select_instance(&self, provider: &str, backend: Option<&str>) -> Option<String>;
    /// `options.portableHandoff(source)` (E5.1's synchronous port).
    fn portable_handoff(&self, source: &str) -> Option<Value>;
    /// Whether the adapter's launch options support `option` (`effort`, `serviceTier`).
    fn supports_launch_option(&self, provider: &str, option: &str) -> bool;
    fn max_input_bytes(&self) -> usize;
}

/// What an accepted creation carries into its receipt.
#[derive(Debug, Clone)]
pub struct CreationValid {
    pub cwd: String,
    pub capabilities: Value,
    pub acp_identity: Option<Value>,
    pub instance_id: Option<String>,
    pub handoff: Option<Value>,
    pub delivery_command: Value,
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// A bounded non-empty string, in code points as the patched zod counts (rule 17).
fn bounded(value: Option<&str>) -> bool {
    value.is_some_and(|text| {
        let points = text.chars().count();
        points > 0 && points <= 256
    })
}

/// `AcpIdentity`: the three ids, each present and bounded.
fn acp_identity(payload: &Value) -> Option<Value> {
    for key in ["acpAgentId", "installationId", "instanceId"] {
        if !bounded(text(payload, key)) {
            return None;
        }
    }
    let mut identity = ace_json::Map::new();
    for key in ["acpAgentId", "installationId", "instanceId"] {
        identity.insert(key, payload.get(key).cloned().unwrap_or(Value::Null));
    }
    Some(Value::Object(identity))
}

/// `cursorInstanceId`: the legacy SDK default maps to the one SDK account.
fn cursor_instance(id: Option<&str>) -> Option<String> {
    match id {
        Some("cursor-cli-default") => Some("cursor-sdk-default".to_owned()),
        other => other.map(str::to_owned),
    }
}

/// `validateCreation`: `Err(code)` is the `CommandResult`'s error.
pub fn validate_creation(
    command: &Value,
    facts: &dyn CreationFacts,
) -> Result<CreationValid, String> {
    let payload = command.get("payload").unwrap_or(&Value::Null);
    let kind = text(payload, "type").unwrap_or_default();
    let fail = str::to_owned;
    if kind != "thread.create" && kind != "thread.prepare" {
        return Err(fail("invalid_command"));
    }
    if payload.get("pullRequest").is_some() && text(payload, "mode") != Some("worktree") {
        return Err(fail("pr_requires_worktree"));
    }
    if let Some(id) = text(payload, "threadId")
        && facts.thread_exists(id)
    {
        return Err(fail("thread_exists"));
    }
    let parts = payload
        .get("input")
        .and_then(Value::as_array)
        .map(|parts| parts.len())
        .unwrap_or(0);
    if kind == "thread.create" && parts > MAX_PARTS {
        return Err(fail("message_too_large"));
    }
    if ace_json::bounded::bounded_json(command, MAX_MESSAGE_BYTES).is_err() {
        return Err(fail("message_too_large"));
    }
    let provider = text(payload, "provider").unwrap_or_default();
    let identity = if provider == "acp" {
        let identity = acp_identity(payload);
        if identity.is_none() {
            return Err(fail("acp_identity_required"));
        }
        identity
    } else {
        None
    };
    if !facts.has_provider(provider, identity.as_ref()) {
        return Err(fail("provider_unavailable"));
    }
    let workspace = text(payload, "workspaceId").unwrap_or_default();
    let Some(path) = facts.workspace(workspace) else {
        return Err(fail("workspace_not_found"));
    };
    let Some(cwd) = facts.directory(&path) else {
        return Err(fail("workspace_unavailable"));
    };
    if facts.reserved(&cwd) {
        return Err(fail("workspace_change_in_progress"));
    }
    let account = text(payload, "accountId")
        .or_else(|| text(payload, "account"))
        .map(str::to_owned);
    let account_id = if provider == "cursor" {
        cursor_instance(account.as_deref())
    } else {
        account
    };
    let create_instance = if kind == "thread.create" {
        text(payload, "instanceId").map(str::to_owned)
    } else {
        None
    };
    if let (Some(instance), Some(account)) = (create_instance.as_deref(), account_id.as_deref()) {
        let mapped = if provider == "cursor" {
            cursor_instance(Some(instance)).unwrap_or_default()
        } else {
            instance.to_owned()
        };
        if mapped != account {
            return Err(fail("conflicting_account_selection"));
        }
    }
    let selected = create_instance
        .or(account_id)
        .or_else(|| facts.select_instance(provider, facts.backend(provider).as_deref()));
    let instance_id = if provider == "cursor" {
        cursor_instance(selected.as_deref())
    } else {
        selected
    };
    let base = Value::Object(ace_json::Map::new());
    let capabilities = facts.permission_capabilities(provider, instance_id.as_deref(), &base);
    // The person's mode runs as the nearest offered one; only an instance with no mode refuses.
    let access = text(payload, "access").filter(|access| *access != "inherit");
    if let Some(access) = access
        && let Some(offers) = facts.access_offers(provider, &capabilities)
        && offers.is_empty()
        && !access.is_empty()
    {
        return Err(fail("permission_mode_unsupported"));
    }
    let handoff = match text(payload, "handoffFrom") {
        None => None,
        Some(source) => {
            if !facts.thread_exists(source) {
                return Err(fail("handoff_source_not_found"));
            }
            Some(
                facts
                    .portable_handoff(source)
                    .ok_or_else(|| fail("handoff_source_not_found"))?,
            )
        }
    };
    if ace_json::bounded::bounded_json(command, MAX_MESSAGE_BYTES).is_err() {
        return Err(fail("queue_capacity_exceeded"));
    }
    if facts.backend(provider).as_deref() == Some("cursor-sdk") && kind == "thread.create" {
        let input = payload.get("input").cloned().unwrap_or(Value::Null);
        if ace_json::bounded::bounded_json(&input, facts.max_input_bytes()).is_err() {
            return Err(fail("provider_input_budget_exceeded"));
        }
    }
    if let Some(options) = payload.get("options").and_then(Value::as_object) {
        for option in ["effort", "serviceTier"] {
            if options.contains_key(option) && !facts.supports_launch_option(provider, option) {
                return Err(fail("launch_options_unsupported"));
            }
        }
    }
    Ok(CreationValid {
        cwd,
        capabilities,
        acp_identity: identity,
        instance_id,
        handoff,
        delivery_command: command.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Facts {
        exists: Vec<String>,
        no_directory: bool,
        reserved: bool,
        acp: bool,
    }

    impl CreationFacts for Facts {
        fn thread_exists(&self, id: &str) -> bool {
            self.exists.iter().any(|known| known == id)
        }
        fn workspace(&self, id: &str) -> Option<String> {
            (id == "w").then(|| "/tmp/work".to_owned())
        }
        fn directory(&self, path: &str) -> Option<String> {
            (!self.no_directory).then(|| path.to_owned())
        }
        fn reserved(&self, _root: &str) -> bool {
            self.reserved
        }
        fn has_provider(&self, provider: &str, _acp: Option<&Value>) -> bool {
            provider == "codex" || (self.acp && provider == "acp")
        }
        fn backend(&self, _provider: &str) -> Option<String> {
            None
        }
        fn permission_capabilities(
            &self,
            _provider: &str,
            _instance: Option<&str>,
            _base: &Value,
        ) -> Value {
            Value::Object(ace_json::Map::new())
        }
        fn access_offers(&self, _provider: &str, _capabilities: &Value) -> Option<Vec<String>> {
            None
        }
        fn select_instance(&self, _provider: &str, _backend: Option<&str>) -> Option<String> {
            None
        }
        fn portable_handoff(&self, _source: &str) -> Option<Value> {
            Some(Value::Object(ace_json::Map::new()))
        }
        fn supports_launch_option(&self, _provider: &str, _option: &str) -> bool {
            false
        }
        fn max_input_bytes(&self) -> usize {
            1024
        }
    }

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    fn create(extra: &str) -> Value {
        value(&format!(
            r#"{{"id":"c","deviceId":"d","payload":{{"type":"thread.create","workspaceId":"w","provider":"codex","input":[{{"type":"text","text":"hi"}}]{extra}}}}}"#
        ))
    }

    #[test]
    fn the_checks_run_in_the_typescripts_order() {
        let facts = Facts::default();
        assert!(validate_creation(&create(""), &facts).is_ok());
        assert_eq!(
            validate_creation(
                &value(
                    r#"{"id":"c","deviceId":"d","payload":{"type":"thread.rename","workspaceId":"w"}}"#
                ),
                &facts
            )
            .unwrap_err(),
            "invalid_command"
        );
        assert_eq!(
            validate_creation(&create(r#","pullRequest":{"number":1}"#), &facts).unwrap_err(),
            "pr_requires_worktree"
        );
        let mut facts = Facts {
            exists: vec!["t".into()],
            ..Facts::default()
        };
        assert_eq!(
            validate_creation(&create(r#","threadId":"t""#), &facts).unwrap_err(),
            "thread_exists"
        );
        facts.no_directory = true;
        assert_eq!(
            validate_creation(&create(""), &facts).unwrap_err(),
            "workspace_unavailable"
        );
        facts.no_directory = false;
        facts.reserved = true;
        assert_eq!(
            validate_creation(&create(""), &facts).unwrap_err(),
            "workspace_change_in_progress"
        );
    }

    #[test]
    fn an_acp_identity_is_required_and_bounded_in_code_points() {
        let facts = Facts {
            acp: true,
            ..Facts::default()
        };
        let acp = |id: &str| {
            value(&format!(
                r#"{{"id":"c","deviceId":"d","payload":{{"type":"thread.create","workspaceId":"w","provider":"acp","input":[],"acpAgentId":"{id}","installationId":"i","instanceId":"a"}}}}"#
            ))
        };
        assert!(validate_creation(&acp("agent"), &facts).is_ok());
        let emoji = "\u{1f600}".repeat(256);
        assert!(validate_creation(&acp(&emoji), &facts).is_ok());
        let too_long = format!("{emoji}\u{1f600}");
        assert_eq!(
            validate_creation(&acp(&too_long), &facts).unwrap_err(),
            "acp_identity_required"
        );
        assert_eq!(
            validate_creation(&acp(""), &facts).unwrap_err(),
            "acp_identity_required"
        );
    }

    #[test]
    fn an_unsupported_launch_option_and_a_missing_handoff_source_refuse() {
        let facts = Facts::default();
        assert_eq!(
            validate_creation(&create(r#","options":{"effort":"high"}"#), &facts).unwrap_err(),
            "launch_options_unsupported"
        );
        assert_eq!(
            validate_creation(&create(r#","handoffFrom":"missing""#), &facts).unwrap_err(),
            "handoff_source_not_found"
        );
    }
}
