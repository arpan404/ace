// SPDX-License-Identifier: Apache-2.0
//! OpenCode provider connections (`opencode-connections.ts`).

use std::collections::BTreeMap;

use ace_models::instance::ModelInstance;
use ace_models::source::{SourceInfo, provider_source, provider_source_with};
use ace_protocol::generated::ModelSource;
use serde_json::Value;

use crate::discovery::process::{ProcessCommand, ProcessRunner, completed};
use crate::failures::DiscoveryFailure;
use crate::sources::SourceStatus;

/// Reads `opencode auth list --standalone --format json`.
pub fn connected_opencode_providers(
    process: &dyn ProcessRunner,
    instance: &ModelInstance,
    aborted: &dyn Fn() -> bool,
) -> Result<BTreeMap<String, ModelSource>, DiscoveryFailure> {
    let args = vec![
        "auth".to_owned(),
        "list".to_owned(),
        "--standalone".to_owned(),
        "--format".to_owned(),
        "json".to_owned(),
    ];
    let command = ProcessCommand::for_instance(instance, args);
    let output = process.run(&command, aborted)?;
    let listing = completed(output)?;
    parse_opencode_connections(&listing)
}

pub fn parse_opencode_connections(
    output: &str,
) -> Result<BTreeMap<String, ModelSource>, DiscoveryFailure> {
    let payload: Value = serde_json::from_str(output).map_err(|_| DiscoveryFailure {
        parse_failure: true,
        ..DiscoveryFailure::default()
    })?;
    let Some(rows) = payload.as_array() else {
        return Err(DiscoveryFailure {
            parse_failure: true,
            ..DiscoveryFailure::default()
        });
    };
    if rows.len() > 512 {
        return Err(DiscoveryFailure::new("Too many connection rows"));
    }
    let mut connected = BTreeMap::new();
    for row in rows {
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() || id.chars().count() > 256 {
            continue;
        }
        let local = row.get("local").and_then(|value| value.as_bool()) == Some(true);
        let connections = row
            .get("connections")
            .and_then(Value::as_array)
            .map(|list| list.len())
            .unwrap_or(0);
        let types: Vec<String> = row
            .get("connections")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|entry| entry.get("type").and_then(Value::as_str))
                    .filter(|ty| ty.chars().count() <= 256)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let auth = row
            .get("connections")
            .and_then(Value::as_array)
            .and_then(|list| {
                list.iter().find_map(|entry| {
                    entry
                        .get("authType")
                        .or(entry.get("method"))
                        .and_then(Value::as_str)
                        .filter(|value| value.chars().count() <= 256)
                        .map(str::to_owned)
                })
            });
        let type_refs: Vec<&str> = types.iter().map(String::as_str).collect();
        let info = SourceInfo {
            name: row.get("name").and_then(Value::as_str),
            local: Some(local),
            base_url: row.get("baseURL").and_then(Value::as_str),
            types: type_refs,
            auth_type: auth.as_deref(),
        };
        let source = provider_source_with(id, &info);
        if connections > 0 || source.kind == ace_protocol::generated::ModelSourceKind::Local {
            connected.insert(id.to_owned(), source);
        }
    }
    Ok(connected)
}

pub fn implied_opencode_providers(
    connected: &BTreeMap<String, ModelSource>,
) -> BTreeMap<String, ModelSource> {
    let Some(zen) = connected.get("opencode") else {
        return BTreeMap::new();
    };
    if zen.kind == ace_protocol::generated::ModelSourceKind::Local || connected.contains_key("opencode-go")
    {
        return BTreeMap::new();
    }
    let mut implied = BTreeMap::new();
    implied.insert("opencode-go".to_owned(), provider_source("opencode-go"));
    implied
}

fn free_cli_id(id: &str) -> bool {
    let Some((provider, model)) = id.split_once('/') else {
        return false;
    };
  ["opencode", "opencode-zen"].contains(&provider)
        && (model.ends_with("-free") || model == "big-pickle")
}

/// Whether an `opencode models` line may join the catalog (`opencode-discovery.ts`).
pub fn cli_listing_eligible(
    id: &str,
    connected: &BTreeMap<String, ModelSource>,
    sources: &BTreeMap<String, SourceStatus>,
) -> bool {
    let Some((provider, _)) = id.split_once('/') else {
        return false;
    };
    if id.chars().count() < 3 || id.chars().count() > 256 || id.contains(char::is_whitespace) {
        return false;
    }
    let listed = sources.get(provider);
    if listed
        .and_then(|status| status.error.as_ref())
        .is_some_and(|error| {
            error.code != crate::failures::FailureCode::NoModels
                && error.code != crate::failures::FailureCode::NotConfigured
        })
    {
        return false;
    }
    let implied = implied_opencode_providers(connected);
    let known = connected.get(provider).or(implied.get(provider));
    let inferred = provider_source(provider);
    if known.is_none() && inferred.kind != ace_protocol::generated::ModelSourceKind::Local && !free_cli_id(id)
    {
        return false;
    }
    true
}