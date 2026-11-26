// SPDX-License-Identifier: Apache-2.0
//! The per-key settings schema (`packages/protocol/src/settings.ts`'s `SettingsValues`).
//!
//! One table owns every key ace reads: its type, bounds and, where the schema fills them,
//! its defaults. [`validate_value`] returns the value Zod would keep, so unknown fields in
//! an object are stripped and a missing defaulted field is filled, and a value the key will
//! not take is refused with the TypeScript's `Invalid value for <key>`.

use ace_protocol::generated::ProviderKind;
use regex::Regex;
use serde_json::{Map, Value};

use crate::validation::{MAX_CLIENT_BYTES, SettingsCode, SettingsError};

const TIERS: &[&str] = &["default", "standard", "fast", "flex", "priority"];
const EFFORTS: &[&str] = &[
    "default", "none", "minimal", "low", "medium", "high", "xhigh", "max",
];
const ACCESS_MODES: &[&str] = &["read-only", "ask", "auto-review", "full-access"];
const FORGES: &[&str] = &[
    "github",
    "gitlab",
    "gitbucket",
    "bitbucket",
    "gitea",
    "forgejo",
    "origin",
];

/// One property's contract.
#[derive(Debug, Clone, Copy)]
pub enum Kind {
    Bool,
    Int {
        min: i64,
        max: i64,
    },
    NullableInt {
        min: i64,
        max: i64,
    },
    Enum(&'static [&'static str]),
    NullableEnum(&'static [&'static str]),
    String {
        min: usize,
        max: usize,
    },
    NullableString {
        min: usize,
        max: usize,
    },
    Provider,
    NullableProvider,
    /// An absolute folder: `/…` or a drive letter, at most 4096.
    NullableAbsolutePath,
    StringList {
        min_len: usize,
        max_len: usize,
        max_items: usize,
    },
    /// `access.nativeModes`: provider to a native mode string.
    NativeModes,
    Json,
    StorageRetention,
    SourceControlPreferences,
    ProviderConfigurations,
    MachineIcon,
    NullableUtilityModel,
    McpPublicUrl,
    RelayUrl,
    PushGatewayUrl,
}

const fn boolean() -> Kind {
    Kind::Bool
}

const fn string(min: usize, max: usize) -> Kind {
    Kind::String { min, max }
}

const ONE: Kind = string(1, 256);

/// Every key, its contract and its shipped default (`defaults.ts`).
pub fn spec(key: &str) -> Option<(Kind, fn() -> Value)> {
    use serde_json::json;
    let entry: (Kind, fn() -> Value) = match key {
        "storage.retention" => (Kind::StorageRetention, || {
            json!({
                "threads": 90,
                "attachments": 30,
                "artifacts": 30,
                "logs": 14,
                "worktrees": 30,
                "caches": 7,
                "idleThreads": false,
                "worktreeMode": "archived"
            })
        }),
        "storage.scheduledCleanup" => (boolean(), || json!(false)),
        "storage.worktreeRetentionDays" => {
            (Kind::NullableInt { min: 1, max: 3650 }, || json!(null))
        }
        "storage.backupWorktrees" => (boolean(), || json!(false)),
        "storage.retentionDays" => (Kind::Int { min: 1, max: 3650 }, || json!(120)),
        "logs.maxBytes" => (
            Kind::Int {
                min: 1024 * 1024,
                max: 64 * 1024 * 1024 * 1024,
            },
            || json!(1024i64 * 1024 * 1024),
        ),
        "sourceControl.preferences" => (
            Kind::SourceControlPreferences,
            || json!({ "hosts": [{ "host": "github.com" }], "host": "github.com", "remote": "origin" }),
        ),
        "providers.configuration" => (Kind::ProviderConfigurations, || json!([])),
        "host.displayName" => (string(0, 256), || json!("")),
        "host.icon" => (Kind::MachineIcon, || json!({ "kind": "laptop" })),
        "projects.roots" => (
            Kind::StringList {
                min_len: 1,
                max_len: 4096,
                max_items: 32,
            },
            || json!([]),
        ),
        "threads.followUpBehavior" => (Kind::Enum(&["steer", "queue"]), || json!("queue")),
        "threads.forkOnSwitch" => (boolean(), || json!(false)),
        "threads.limitPolicy" => (
            Kind::Enum(&[
                "manual",
                "resume_at_reset",
                "snooze_until_reset",
                "migrate_now",
            ]),
            || json!("manual"),
        ),
        "providers.default" => (Kind::Provider, || json!("codex")),
        "providers.coder.provider" => (Kind::NullableProvider, || json!(null)),
        "providers.coder.model" => (ONE, || json!("default")),
        "providers.coder.tier" => (Kind::Enum(TIERS), || json!("default")),
        "providers.coder.reasoningEffort" => (Kind::Enum(EFFORTS), || json!("default")),
        "providers.reviewer.provider" => (Kind::NullableProvider, || json!(null)),
        "providers.reviewer.model" => (ONE, || json!("default")),
        "providers.reviewer.tier" => (Kind::Enum(TIERS), || json!("default")),
        "providers.reviewer.reasoningEffort" => (Kind::Enum(EFFORTS), || json!("default")),
        "providers.planner.provider" => (Kind::NullableProvider, || json!(null)),
        "providers.planner.model" => (ONE, || json!("default")),
        "providers.planner.tier" => (Kind::Enum(TIERS), || json!("default")),
        "providers.planner.reasoningEffort" => (Kind::Enum(EFFORTS), || json!("default")),
        "providers.verifier.provider" => (Kind::NullableProvider, || json!(null)),
        "providers.verifier.model" => (ONE, || json!("default")),
        "providers.verifier.tier" => (Kind::Enum(TIERS), || json!("default")),
        "providers.verifier.reasoningEffort" => (Kind::Enum(EFFORTS), || json!("default")),
        "providers.codex.toolSource" => (Kind::NullableAbsolutePath, || json!(null)),
        "providers.claude.chrome" => (Kind::Enum(&["auto", "on", "off"]), || json!("auto")),
        "browser.backend" => (Kind::Enum(&["auto", "embedded", "headless"]), || {
            json!("auto")
        }),
        "browser.backendLoss" => (Kind::Enum(&["pause", "headless"]), || json!("pause")),
        "browser.profile" => (Kind::Enum(&["persistent", "ephemeral"]), || {
            json!("persistent")
        }),
        "browser.profileScope" => (Kind::Enum(&["global", "project", "thread"]), || {
            json!("global")
        }),
        "browser.downloadDir" => (string(0, 4096), || json!("")),
        "browser.downloadDefault" => (string(0, 4096), || json!("")),
        "browser.userChrome.storageReads" => (boolean(), || json!(false)),
        "computer.blockedApps" => (
            Kind::StringList {
                min_len: 1,
                max_len: 200,
                max_items: 200,
            },
            || json!([]),
        ),
        "computer.lockedUse" => (boolean(), || json!(false)),
        "spade.enabled" => (boolean(), || json!(false)),
        "beta.spade" => (boolean(), || json!(false)),
        "beta.marketplace" => (boolean(), || json!(false)),
        "market.askBeforeAgentPublish" => (boolean(), || json!(false)),
        "devices.emulatorWindow" => (boolean(), || json!(false)),
        "devices.enabled" => (boolean(), || json!(true)),
        "access.defaultMode" => (Kind::Enum(ACCESS_MODES), || json!("auto-review")),
        "access.nativeModes" => (Kind::NativeModes, || json!({})),
        "threads.useWorktree" => (boolean(), || json!(true)),
        "worktree.preparationTimeoutMs" => (
            Kind::Int {
                min: 60_000,
                max: 3_600_000,
            },
            || json!(600_000),
        ),
        "threads.autoSettleAfter" => (Kind::Enum(&["1d", "2d", "1w", "never"]), || json!("1d")),
        "threads.unresponsiveAfter" => (Kind::Enum(&["2m", "5m", "15m"]), || json!("5m")),
        "threads.settleOnMerge" => (boolean(), || json!(true)),
        "threads.settleOnClose" => (boolean(), || json!(false)),
        "threads.sortBy" => (Kind::Enum(&["activity", "created", "manual"]), || {
            json!("activity")
        }),
        "threads.keepSettledFor" => (Kind::Enum(&["0d", "1d", "3d", "7d"]), || json!("3d")),
        "remote.enabled" => (boolean(), || json!(true)),
        "remote.transport" => (Kind::Enum(&["local", "lan", "tailscale", "relay"]), || {
            json!("local")
        }),
        "remote.lan" => (boolean(), || json!(true)),
        "remote.tailscale" => (boolean(), || json!(false)),
        "remote.relay" => (boolean(), || json!(false)),
        "remote.agentAccess" => (Kind::Enum(&["off", "read", "operate"]), || json!("off")),
        "remote.agentTransfers" => (boolean(), || json!(true)),
        "remote.transferIgnoredFiles" => (boolean(), || json!(true)),
        "remote.hostedPairingLink" => (boolean(), || json!(false)),
        "remote.machineLocalhost" => (boolean(), || json!(true)),
        "remote.relayMcp" => (boolean(), || json!(false)),
        "remote.relayWebhooks" => (boolean(), || json!(false)),
        "remote.tailscaleWebhooks" => (boolean(), || json!(false)),
        "remote.publicUrlWebhooks" => (boolean(), || json!(false)),
        "remote.tailscaleMcp" => (boolean(), || json!(false)),
        "remote.mcpPublicUrl" => (Kind::McpPublicUrl, || json!(null)),
        "remote.relayUrl" => (Kind::RelayUrl, || json!("")),
        "notifications.remotePush" => (boolean(), || json!(true)),
        "notifications.pushGatewayUrl" => {
            (Kind::PushGatewayUrl, || json!("https://push.acehq.dev"))
        }
        "automations.enabled" => (boolean(), || json!(false)),
        "agents.maxRunningChildren" => (Kind::NullableInt { min: 1, max: 64 }, || json!(null)),
        "generation.model" => (Kind::NullableUtilityModel, || json!(null)),
        "generation.autoDraftCommits" => (boolean(), || json!(true)),
        "clients.theme" => (Kind::Json, || json!({})),
        "clients.keybindings" => (Kind::Json, || json!({})),
        _ => return None,
    };
    Some(entry)
}

/// Whether `key` is one this build reads (`SettingsKey`).
pub fn is_key(key: &str) -> bool {
    spec(key).is_some()
}

/// The shipped default for a key.
pub fn default_value(key: &str) -> Option<Value> {
    spec(key).map(|(_, default)| default())
}

fn invalid(key: &str, code: SettingsCode) -> SettingsError {
    SettingsError::new(code, &format!("Invalid value for {key}"))
}

fn matches_enum(value: &Value, options: &[&str]) -> bool {
    value.as_str().is_some_and(|text| options.contains(&text))
}

/// A string's length as Zod measures it: UTF-16 code units, not code points, so 129 emoji
/// are 258 units and a `.max(256)` refuses them.
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn text_len(value: &Value) -> Option<usize> {
    value.as_str().map(utf16_len)
}

/// An integer-valued JSON number: Zod's `.int()` keeps `1.0` as `1`.
fn integer(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_992.0)
        .then_some(number as i64)
}

fn pattern(source: &str) -> Option<Regex> {
    Regex::new(source).ok()
}

fn provider(value: &Value) -> Option<ProviderKind> {
    value.as_str().and_then(|text| text.parse().ok())
}

/// A number's length as `JSON.stringify` writes it: an integer-valued number is printed
/// without a fractional part.
fn js_number_len(number: &serde_json::Number) -> usize {
    if let Some(value) = number.as_i64() {
        return value.to_string().len();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string().len();
    }
    match number.as_f64() {
        Some(value) if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21 => {
            (value as i64).to_string().len()
        }
        _ => number.to_string().len(),
    }
}

/// The size of the blob as the TypeScript measures it: `Buffer.byteLength(JSON.stringify(v))`,
/// so a JSON array of `0.0` literals counts each as one `0`, not serde's `0.0`.
fn json_stringify_len(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(number) => js_number_len(number),
        Value::String(text) => serde_json::to_string(text).map_or(2, |text| text.len()),
        Value::Array(items) => {
            2 + items.iter().map(json_stringify_len).sum::<usize>() + items.len().saturating_sub(1)
        }
        Value::Object(entries) => {
            let mut total = 2;
            for (index, (key, item)) in entries.iter().enumerate() {
                if index > 0 {
                    total += 1;
                }
                total += serde_json::to_string(key).map_or(2, |key| key.len()) + 1;
                total += json_stringify_len(item);
            }
            total
        }
    }
}

/// The value Zod keeps for `key`, or the refusal a person sees.
pub fn validate_value(key: &str, value: &Value) -> Result<Value, SettingsError> {
    let (kind, _) = spec(key)
        .ok_or_else(|| SettingsError::new(SettingsCode::Validation, "Unknown settings key"))?;
    if key.starts_with("clients.") {
        let bytes = json_stringify_len(value);
        if bytes > MAX_CLIENT_BYTES {
            return Err(SettingsError::new(
                SettingsCode::Size,
                "Client settings blob exceeds 64 KiB",
            ));
        }
    }
    validate_kind(key, kind, value)
}

fn validate_kind(key: &str, kind: Kind, value: &Value) -> Result<Value, SettingsError> {
    let refusal = || invalid(key, SettingsCode::Validation);
    match kind {
        Kind::Bool => value.as_bool().map(Value::Bool).ok_or_else(refusal),
        Kind::Int { min, max } => integer(value)
            .filter(|number| (min..=max).contains(number))
            .map(Value::from)
            .ok_or_else(refusal),
        Kind::NullableInt { min, max } => match value {
            Value::Null => Ok(Value::Null),
            _ => integer(value)
                .filter(|number| (min..=max).contains(number))
                .map(Value::from)
                .ok_or_else(refusal),
        },
        Kind::Enum(options) => {
            if matches_enum(value, options) {
                Ok(value.clone())
            } else {
                Err(refusal())
            }
        }
        Kind::NullableEnum(options) => match value {
            Value::Null => Ok(Value::Null),
            _ if matches_enum(value, options) => Ok(value.clone()),
            _ => Err(refusal()),
        },
        Kind::String { min, max } => text_len(value)
            .filter(|length| (min..=max).contains(length))
            .map(|_| value.clone())
            .ok_or_else(refusal),
        Kind::NullableString { min, max } => match value {
            Value::Null => Ok(Value::Null),
            _ => text_len(value)
                .filter(|length| (min..=max).contains(length))
                .map(|_| value.clone())
                .ok_or_else(refusal),
        },
        Kind::Provider => provider(value)
            .map(|provider| Value::String(provider.to_string()))
            .ok_or_else(refusal),
        Kind::NullableProvider => match value {
            Value::Null => Ok(Value::Null),
            _ => provider(value)
                .map(|provider| Value::String(provider.to_string()))
                .ok_or_else(refusal),
        },
        Kind::NullableAbsolutePath => match value {
            Value::Null => Ok(Value::Null),
            Value::String(path) if kind_absolute_path_fits(path) => Ok(Value::String(path.clone())),
            _ => Err(refusal()),
        },
        Kind::StringList {
            min_len,
            max_len,
            max_items,
        } => {
            let items = value.as_array().ok_or_else(refusal)?;
            if items.len() > max_items {
                return Err(refusal());
            }
            let mut kept = Vec::with_capacity(items.len());
            for item in items {
                let length = text_len(item).ok_or_else(refusal)?;
                if !(min_len..=max_len).contains(&length) {
                    return Err(refusal());
                }
                kept.push(item.clone());
            }
            Ok(Value::Array(kept))
        }
        Kind::NativeModes => {
            let entries = value.as_object().ok_or_else(refusal)?;
            let mut kept = Map::new();
            for (name, mode) in entries {
                let Some(provider) = provider(&Value::String(name.clone())) else {
                    continue;
                };
                let mode = mode.as_str().ok_or_else(refusal)?;
                if !(1..=4096).contains(&utf16_len(mode)) {
                    return Err(refusal());
                }
                kept.insert(provider.to_string(), Value::String(mode.to_owned()));
            }
            Ok(Value::Object(kept))
        }
        Kind::Json => Ok(value.clone()),
        Kind::StorageRetention => storage_retention(value),
        Kind::SourceControlPreferences => source_control_preferences(value),
        Kind::ProviderConfigurations => provider_configurations(value),
        Kind::MachineIcon => machine_icon(value),
        Kind::NullableUtilityModel => match value {
            Value::Null => Ok(Value::Null),
            _ => utility_model(value),
        },
        Kind::McpPublicUrl => mcp_public_url(value),
        Kind::RelayUrl => relay_url(value),
        Kind::PushGatewayUrl => push_gateway_url(value),
    }
}

fn kind_absolute_path_fits(path: &str) -> bool {
    let length = utf16_len(path);
    (1..=4096).contains(&length)
        && (path.starts_with('/')
            || (path.len() > 2
                && path.as_bytes()[0].is_ascii_alphabetic()
                && path.as_bytes()[1] == b':'
                && matches!(path.as_bytes()[2], b'/' | b'\\')))
        && !path.chars().any(|c| c.is_control())
}

/// Each category's window: `days` in `storage.ts` as `1..=36500` or `null` to disable it.
/// The 3,650-day cap belongs to `storage.retentionDays` alone.
fn retention_days(value: &Value) -> Option<Value> {
    match value {
        Value::Null => Some(Value::Null),
        _ => value
            .as_i64()
            .filter(|number| (1..=36_500).contains(number))
            .map(Value::from),
    }
}

fn storage_retention(value: &Value) -> Result<Value, SettingsError> {
    let entries = value
        .as_object()
        .ok_or_else(|| invalid("storage.retention", SettingsCode::Validation))?;
    let days = |name: &str, fallback: i64| -> Result<Value, SettingsError> {
        match entries.get(name) {
            None => Ok(Value::from(fallback)),
            Some(value) => retention_days(value)
                .ok_or_else(|| invalid("storage.retention", SettingsCode::Validation)),
        }
    };
    let mut kept = Map::new();
    for (name, fallback) in [
        ("threads", 90),
        ("attachments", 30),
        ("artifacts", 30),
        ("logs", 14),
        ("worktrees", 30),
        ("caches", 7),
    ] {
        kept.insert(name.to_owned(), days(name, fallback)?);
    }
    kept.insert(
        "idleThreads".to_owned(),
        Value::Bool(
            entries
                .get("idleThreads")
                .map(|value| {
                    value
                        .as_bool()
                        .ok_or_else(|| invalid("storage.retention", SettingsCode::Validation))
                })
                .transpose()?
                .unwrap_or(false),
        ),
    );
    if let Some(mode) = entries.get("worktreeMode") {
        if !matches_enum(mode, &["archived", "settled", "all_settled"]) {
            return Err(invalid("storage.retention", SettingsCode::Validation));
        }
        kept.insert("worktreeMode".to_owned(), mode.clone());
    }
    Ok(Value::Object(kept))
}

/// The public host whose provider is fixed (`forge.ts`'s `publicForgeHosts`).
fn public_forge_host(host: &str) -> Option<&'static str> {
    match host {
        "github.com" => Some("github"),
        "gitlab.com" => Some("gitlab"),
        "bitbucket.org" => Some("bitbucket"),
        "codeberg.org" => Some("forgejo"),
        "origin.cursor.com" => Some("origin"),
        _ => None,
    }
}

/// Cursor Origin is one hosted service: its API host is the only host it can have.
const ORIGIN_API_HOST: &str = "origin.cursor.com";

/// `configuredForge`: the explicit provider, else the public host's, else GitHub.
fn configured_forge(host: &str, forge: Option<&str>) -> &'static str {
    match forge {
        Some(forge) => FORGES
            .iter()
            .find(|option| **option == forge)
            .copied()
            .unwrap_or("github"),
        None => public_forge_host(host).unwrap_or("github"),
    }
}

fn github_host(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (utf16_len(text) <= 253
        && pattern(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$").is_some_and(|p| p.is_match(text)))
    .then(|| text.to_owned())
}

fn source_control_preferences(value: &Value) -> Result<Value, SettingsError> {
    let refusal = || invalid("sourceControl.preferences", SettingsCode::Validation);
    let entries = value.as_object().ok_or_else(refusal)?;
    let hosts = entries
        .get("hosts")
        .and_then(Value::as_array)
        .ok_or_else(refusal)?;
    if hosts.is_empty() || hosts.len() > 32 {
        return Err(refusal());
    }
    let mut kept_hosts = Vec::with_capacity(hosts.len());
    let mut names = Vec::new();
    for host in hosts {
        let host = host.as_object().ok_or_else(refusal)?;
        let name = github_host(host.get("host").unwrap_or(&Value::Null)).ok_or_else(refusal)?;
        if names.contains(&name) {
            return Err(refusal());
        }
        names.push(name.clone());
        if let Some(forge) = host.get("forge")
            && !matches_enum(forge, FORGES)
        {
            return Err(refusal());
        }
        let forge = configured_forge(&name, host.get("forge").and_then(Value::as_str));
        // A provider that contradicts its host is refused: `github.com` is GitHub, and
        // Cursor Origin is only its own host.
        if public_forge_host(&name).is_some_and(|fixed| fixed != forge)
            || (forge == "origin" && name != ORIGIN_API_HOST)
        {
            return Err(refusal());
        }
        let mut kept = Map::new();
        kept.insert("host".to_owned(), Value::String(name));
        if let Some(provider) = host.get("forge") {
            kept.insert("forge".to_owned(), provider.clone());
        }
        if let Some(account) = host.get("account") {
            let fits = account.as_str().is_some_and(|account| {
                (utf16_len(account) <= 254 && account.contains('@'))
                    || (utf16_len(account) <= 100
                        && pattern(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")
                            .is_some_and(|p| p.is_match(account)))
            });
            if !fits {
                return Err(refusal());
            }
            // A GitHub account is GitHub's own login shape.
            if forge == "github"
                && !account.as_str().is_some_and(|account| {
                    utf16_len(account) <= 100
                        && pattern(r"^[a-zA-Z0-9][a-zA-Z0-9-]*$")
                            .is_some_and(|p| p.is_match(account))
                })
            {
                return Err(refusal());
            }
            kept.insert("account".to_owned(), account.clone());
        }
        kept_hosts.push(Value::Object(kept));
    }
    let host = github_host(entries.get("host").unwrap_or(&Value::Null)).ok_or_else(refusal)?;
    if !names.iter().any(|name| name == &host) {
        return Err(refusal());
    }
    let remote = entries.get("remote").and_then(Value::as_str).unwrap_or("");
    if remote.is_empty()
        || utf16_len(remote) > 100
        || !pattern(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$").is_some_and(|p| p.is_match(remote))
    {
        return Err(refusal());
    }
    let mut kept = Map::new();
    kept.insert("hosts".to_owned(), Value::Array(kept_hosts));
    kept.insert("host".to_owned(), Value::String(host));
    kept.insert("remote".to_owned(), Value::String(remote.to_owned()));
    Ok(Value::Object(kept))
}

/// One `ProviderConfiguration`: unknown fields are stripped, `binaryPath` is optional.
fn provider_configuration(value: &Value) -> Result<Value, SettingsError> {
    let refusal = || invalid("providers.configuration", SettingsCode::Validation);
    let row = value.as_object().ok_or_else(refusal)?;
    let provider = row.get("provider").and_then(provider).ok_or_else(refusal)?;
    let mut kept = Map::new();
    kept.insert("provider".to_owned(), Value::String(provider.to_string()));
    if let Some(instance) = row.get("instance") {
        let text = instance.as_str().ok_or_else(refusal)?;
        if text.is_empty()
            || utf16_len(text) > 256
            || text.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(refusal());
        }
        kept.insert("instance".to_owned(), instance.clone());
    }
    if let Some(enabled) = row.get("enabled") {
        enabled.as_bool().ok_or_else(refusal)?;
        kept.insert("enabled".to_owned(), enabled.clone());
    }
    if let Some(model) = row.get("defaultModel") {
        if !model.is_null() {
            let text = model.as_str().ok_or_else(refusal)?;
            if text.is_empty() || text.eq_ignore_ascii_case("default") {
                return Err(refusal());
            }
            checked_id(text).ok_or_else(refusal)?;
        }
        kept.insert("defaultModel".to_owned(), model.clone());
    }
    if let Some(path) = row.get("binaryPath") {
        let text = path.as_str().ok_or_else(refusal)?;
        if !kind_absolute_path_fits(text) {
            return Err(refusal());
        }
        kept.insert("binaryPath".to_owned(), path.clone());
    }
    for name in [
        "hiddenModels",
        "shownModels",
        "hiddenGroups",
        "shownGroups",
        "favourites",
    ] {
        if let Some(list) = row.get(name) {
            let items = list.as_array().ok_or_else(refusal)?;
            if items.len() > 512 {
                return Err(refusal());
            }
            let mut seen = Vec::new();
            for item in items {
                let id = item.as_str().ok_or_else(refusal)?;
                let id = checked_id(id).ok_or_else(refusal)?;
                if seen.contains(&id) {
                    return Err(refusal());
                }
                seen.push(id);
            }
            kept.insert(name.to_owned(), list.clone());
        }
    }
    if let Some(models) = row.get("customModels") {
        let items = models.as_array().ok_or_else(refusal)?;
        if items.len() > 128 {
            return Err(refusal());
        }
        let mut seen = Vec::new();
        for model in items {
            let model = model.as_object().ok_or_else(refusal)?;
            let id = model
                .get("id")
                .and_then(Value::as_str)
                .and_then(checked_id)
                .ok_or_else(refusal)?;
            if seen.contains(&id) {
                return Err(refusal());
            }
            seen.push(id);
            let display = model
                .get("displayName")
                .and_then(Value::as_str)
                .ok_or_else(refusal)?;
            if !(1..=256).contains(&utf16_len(display))
                || !display.chars().any(|c| !c.is_whitespace())
            {
                return Err(refusal());
            }
        }
        kept.insert("customModels".to_owned(), models.clone());
    }
    for name in ["showOnlyFavourites", "hideDeprecated"] {
        if let Some(value) = row.get(name) {
            value.as_bool().ok_or_else(refusal)?;
            kept.insert(name.to_owned(), value.clone());
        }
    }
    if let Some(mb) = row.get("maxCheckpointMb") {
        mb.as_i64()
            .filter(|value| (1..=65536).contains(value))
            .ok_or_else(refusal)?;
        kept.insert("maxCheckpointMb".to_owned(), mb.clone());
    }
    Ok(Value::Object(kept))
}

fn checked_id(text: &str) -> Option<String> {
    let fits = (1..=256).contains(&utf16_len(text))
        && !text.chars().any(|c| c.is_whitespace() || c.is_control());
    fits.then(|| text.to_owned())
}

fn provider_configurations(value: &Value) -> Result<Value, SettingsError> {
    let rows = value
        .as_array()
        .ok_or_else(|| invalid("providers.configuration", SettingsCode::Validation))?;
    if rows.len() > 64 {
        return Err(invalid("providers.configuration", SettingsCode::Validation));
    }
    let mut kept = Vec::with_capacity(rows.len());
    let mut seen = Vec::new();
    for row in rows {
        let kept_row = provider_configuration(row)?;
        let key = format!(
            "{}:{}",
            kept_row
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or(""),
            kept_row
                .get("instance")
                .and_then(Value::as_str)
                .unwrap_or("")
        );
        if seen.contains(&key) {
            return Err(invalid("providers.configuration", SettingsCode::Validation));
        }
        seen.push(key);
        kept.push(kept_row);
    }
    Ok(Value::Array(kept))
}

fn machine_icon(value: &Value) -> Result<Value, SettingsError> {
    let refusal = || invalid("host.icon", SettingsCode::Validation);
    let icon = value.as_object().ok_or_else(refusal)?;
    let kind = icon.get("kind").ok_or_else(refusal)?;
    if !matches_enum(
        kind,
        &[
            "laptop", "desktop", "monitor", "server", "cloud", "cpu", "terminal", "phone",
        ],
    ) {
        return Err(refusal());
    }
    let mut kept = Map::new();
    kept.insert("kind".to_owned(), kind.clone());
    if let Some(color) = icon.get("color") {
        if !matches_enum(color, &["default", "blue", "green", "purple", "orange"]) {
            return Err(refusal());
        }
        kept.insert("color".to_owned(), color.clone());
    }
    Ok(Value::Object(kept))
}

fn utility_model(value: &Value) -> Result<Value, SettingsError> {
    let refusal = || invalid("generation.model", SettingsCode::Validation);
    let choice = value.as_object().ok_or_else(refusal)?;
    let mut kept = Map::new();
    let provider = choice
        .get("provider")
        .and_then(provider)
        .ok_or_else(refusal)?;
    kept.insert("provider".to_owned(), Value::String(provider.to_string()));
    if let Some(instance) = choice.get("instance") {
        let text = instance.as_str().ok_or_else(refusal)?;
        if !(1..=256).contains(&utf16_len(text)) {
            return Err(refusal());
        }
        kept.insert("instance".to_owned(), instance.clone());
    }
    for name in ["model", "effort"] {
        if let Some(field) = choice.get(name) {
            let text = field.as_str().ok_or_else(refusal)?;
            if !(1..=256).contains(&utf16_len(text)) {
                return Err(refusal());
            }
            kept.insert(name.to_owned(), field.clone());
        }
    }
    if !kept.contains_key("model") {
        return Err(refusal());
    }
    Ok(Value::Object(kept))
}

fn mcp_public_url(value: &Value) -> Result<Value, SettingsError> {
    let refusal = || invalid("remote.mcpPublicUrl", SettingsCode::Validation);
    match value {
        Value::Null => Ok(Value::Null),
        Value::String(text) if utf16_len(text) <= 2048 => {
            let Some(parsed) = url::Url::parse(text).ok() else {
                return Err(refusal());
            };
            let origin_only = parsed.scheme() == "https"
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.query().is_none()
                && parsed.fragment().is_none()
                && parsed.path() == "/"
                && !text.ends_with('/');
            if !origin_only {
                return Err(refusal());
            }
            Ok(value.clone())
        }
        _ => Err(refusal()),
    }
}

fn relay_url(value: &Value) -> Result<Value, SettingsError> {
    let refusal = || invalid("remote.relayUrl", SettingsCode::Validation);
    let text = value.as_str().ok_or_else(refusal)?;
    if utf16_len(text) > 2048 {
        return Err(refusal());
    }
    if text.is_empty() {
        return Ok(value.clone());
    }
    let parsed = url::Url::parse(text).map_err(|_| refusal())?;
    let secure = parsed.scheme() == "wss"
        || (parsed.scheme() == "ws" && parsed.host_str() == Some("127.0.0.1"));
    if !secure
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(refusal());
    }
    Ok(value.clone())
}

fn push_gateway_url(value: &Value) -> Result<Value, SettingsError> {
    let refusal = || invalid("notifications.pushGatewayUrl", SettingsCode::Validation);
    let text = value.as_str().ok_or_else(refusal)?;
    if utf16_len(text) > 2048 {
        return Err(refusal());
    }
    let parsed = url::Url::parse(text).map_err(|_| refusal())?;
    let allowed = parsed.scheme() == "https"
        || (parsed.scheme() == "http" && parsed.host_str() == Some("127.0.0.1"));
    if !allowed
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(refusal());
    }
    Ok(value.clone())
}

#[cfg(test)]
mod tests {
    //! Ports the failing inputs of the settings review: an unknown or mistyped known
    //! value is refused ("Settings document has invalid known values"), the retired
    //! `remote.transport` value still parses, and `version: 2.0` is accepted.

    use super::*;
    use serde_json::json;

    #[test]
    fn known_values_are_checked_against_their_key() {
        assert!(validate_value("threads.followUpBehavior", &json!("queue")).is_ok());
        assert_eq!(
            validate_value("threads.followUpBehavior", &json!("soon"))
                .map_err(|error| (error.code, error.message)),
            Err((
                SettingsCode::Validation,
                "Invalid value for threads.followUpBehavior".into()
            ))
        );
        assert!(validate_value("providers.coder.provider", &json!(null)).is_ok());
        assert!(validate_value("providers.coder.provider", &json!("chatgpt")).is_err());
        assert!(validate_value("logs.maxBytes", &json!(1024)).is_err());
        assert!(is_key("threads.settleOnClose"));
        assert!(!is_key("threads.settleSoon"));
    }

    #[test]
    fn an_object_key_fills_its_defaults_and_strips_unknown_fields() {
        let kept = validate_value(
            "storage.retention",
            &json!({ "threads": 30, "futureField": true }),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(kept["threads"], 30);
        assert_eq!(kept["attachments"], 30);
        assert_eq!(kept["idleThreads"], false);
        assert!(kept.get("futureField").is_none());
    }

    #[test]
    fn retention_categories_may_be_null_or_up_to_ten_thousand_days() {
        let kept = validate_value(
            "storage.retention",
            &json!({ "threads": null, "logs": 10_000 }),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(kept["threads"], Value::Null, "null disables the category");
        assert_eq!(kept["logs"], 10_000);
        assert_eq!(
            kept["attachments"], 30,
            "an absent category keeps its default"
        );
        assert!(validate_value("storage.retention", &json!({ "threads": 36_500 })).is_ok());
        for bad in [json!(0), json!(36_501), json!("30")] {
            assert!(
                validate_value("storage.retention", &json!({ "threads": bad })).is_err(),
                "{bad}"
            );
        }
        // `storage.retentionDays` keeps the separate 3,650-day cap.
        assert!(validate_value("storage.retentionDays", &json!(3651)).is_err());
    }

    #[test]
    fn provider_rows_keep_their_contract_and_unique_pairs() {
        let rows = json!([{
            "provider": "cursor",
            "instance": "work",
            "binaryPath": "/opt/cursor",
            "futureField": 1
        }]);
        let kept = validate_value("providers.configuration", &rows)
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(kept[0].get("futureField").is_none());
        let duplicate = json!([
            { "provider": "cursor" },
            { "provider": "cursor" }
        ]);
        assert!(validate_value("providers.configuration", &duplicate).is_err());
    }

    #[test]
    fn the_client_blob_cap_is_utf8_bytes() {
        let text = "🚀".repeat(MAX_CLIENT_BYTES / 4 + 1);
        assert_eq!(
            validate_value("clients.theme", &json!(text)).map_err(|error| error.code),
            Err(SettingsCode::Size)
        );
    }

    #[test]
    fn string_bounds_count_utf16_units_and_integers_may_be_integer_valued() {
        let refused = "😀".repeat(129);
        assert!(
            validate_value("host.displayName", &json!(refused)).is_err(),
            "258 UTF-16 units exceed 256"
        );
        assert!(validate_value("host.displayName", &json!("😀".repeat(128))).is_ok());
        assert_eq!(
            validate_value("agents.maxRunningChildren", &json!(1.0)).ok(),
            Some(json!(1))
        );
        assert!(validate_value("agents.maxRunningChildren", &json!(1.5)).is_err());
    }

    #[test]
    fn a_source_control_host_must_agree_with_its_provider() {
        let good = json!({
            "hosts": [{ "host": "github.com", "account": "octocat" }],
            "host": "github.com",
            "remote": "origin"
        });
        assert!(validate_value("sourceControl.preferences", &good).is_ok());
        let mismatched = json!({
            "hosts": [{ "host": "github.com", "forge": "gitlab" }],
            "host": "github.com",
            "remote": "origin"
        });
        assert!(validate_value("sourceControl.preferences", &mismatched).is_err());
        let origin_elsewhere = json!({
            "hosts": [{ "host": "git.example.com", "forge": "origin" }],
            "host": "git.example.com",
            "remote": "origin"
        });
        assert!(validate_value("sourceControl.preferences", &origin_elsewhere).is_err());
        let origin = json!({
            "hosts": [{ "host": "origin.cursor.com", "forge": "origin" }],
            "host": "origin.cursor.com",
            "remote": "origin"
        });
        assert!(validate_value("sourceControl.preferences", &origin).is_ok());
        let dotted_github_account = json!({
            "hosts": [{ "host": "github.com", "account": "a.b" }],
            "host": "github.com",
            "remote": "origin"
        });
        assert!(validate_value("sourceControl.preferences", &dotted_github_account).is_err());
    }

    #[test]
    fn the_client_blob_cap_counts_json_stringify_bytes_and_reports_a_size_diagnostic() {
        // 17,000 `0.0` literals: 34,001 bytes as `JSON.stringify` writes them, so the size
        // the crate measures must not refuse what the TypeScript accepts.
        let zeros = Value::Array(vec![json!(0.0); 17_000]);
        assert!(validate_value("clients.theme", &zeros).is_ok());

        let oversized = json!("é".repeat(MAX_CLIENT_BYTES));
        assert_eq!(
            validate_value("clients.theme", &oversized)
                .map_err(|error| (error.code, error.message)),
            Err((
                SettingsCode::Size,
                "Client settings blob exceeds 64 KiB".into()
            ))
        );

        // Reading a document with an oversized blob reports `size`, not the generic
        // invalid-known-values refusal.
        let text = serde_json::json!({
            "version": 2,
            "settings": { "clients.theme": "a".repeat(MAX_CLIENT_BYTES) }
        })
        .to_string();
        assert_eq!(
            crate::document::DecodedDocument::decode(&text)
                .map_err(|error| (error.code, error.message)),
            Err((
                SettingsCode::Size,
                "Client settings blob exceeds 64 KiB".into()
            ))
        );

        // And the accepted array reads back.
        let text = serde_json::json!({
            "version": 2,
            "settings": { "clients.theme": Value::Array(vec![json!(0.0); 17_000]) }
        })
        .to_string();
        assert!(crate::document::DecodedDocument::decode(&text).is_ok());
    }

    #[test]
    fn origins_are_https_without_path_query_or_credentials() {
        assert_eq!(
            validate_value("remote.mcpPublicUrl", &json!("https://ace.example.com"))
                .unwrap_or(Value::Null),
            json!("https://ace.example.com")
        );
        for bad in [
            json!("https://ace.example.com/"),
            json!("http://ace.example.com"),
            json!("https://ace.example.com/path"),
            json!("https://user:pass@ace.example.com"),
        ] {
            assert!(
                validate_value("remote.mcpPublicUrl", &bad).is_err(),
                "{bad}"
            );
        }
        assert!(validate_value("remote.relayUrl", &json!("")).is_ok());
        assert!(validate_value("remote.relayUrl", &json!("wss://relay.example.com/")).is_ok());
        assert!(validate_value("remote.relayUrl", &json!("ws://relay.example.com/")).is_err());
        assert!(validate_value("remote.relayUrl", &json!("ws://127.0.0.1:1234/")).is_ok());
    }
}
