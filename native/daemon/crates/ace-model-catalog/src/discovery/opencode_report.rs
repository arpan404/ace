// SPDX-License-Identifier: Apache-2.0
//! OpenCode's eligible sources (`opencode-connections.ts`, `opencode-report.ts`,
//! `opencode-discovery.ts`).
//!
//! OpenCode's v2 catalog can list providers the account never connected. A provider joins
//! the picker only when the CLI reports a connection for it, when it is local, when it is
//! one of Zen/Go's free choices, or when OpenCode Go is implied by a Zen login. The
//! `models` listing fills in ids the catalog has no metadata for; its own failures never
//! discard the catalog, they mark the sources it could not fill stale.

use std::collections::{BTreeSet, HashSet};

use ace_models::instance::ModelInstance;
use ace_models::source::{SourceInfo, model_source_with, provider_source, provider_source_with};
use ace_protocol::generated::{CatalogModel, ModelSource, ModelSourceKind};
use serde_json::Value;

use crate::failures::{DiscoveryFailure, ErrorContext, FailureCode, discovery_error};
use crate::sources::{SourceState, SourceStatus};

/// The source of every model a provider serves, as a provider index.
pub type Connected = Vec<(String, ModelSource)>;

/// The catalog before the CLI's id-only listing supplements it.
#[derive(Debug, Default)]
pub struct OpenCodeReport {
    pub models: Vec<CatalogModel>,
    pub sources: Vec<SourceStatus>,
    /// A source whose provider answered with no chat models.
    pub missing_metadata: BTreeSet<String>,
    /// Every `provider/model` the catalog itself listed; the CLI cannot override them.
    pub metadata_ids: BTreeSet<String>,
    /// The sources a failed provider could not contribute.
    pub source_failures: Vec<(String, String)>,
}

fn text_between(value: Option<&Value>, min: usize, max: usize) -> Result<String, ()> {
    let text = value.and_then(Value::as_str).ok_or(())?;
    if (min..=max).contains(&text.chars().count()) {
        Ok(text.to_owned())
    } else {
        Err(())
    }
}

fn optional_text(value: Option<&Value>, min: usize, max: usize) -> Result<Option<String>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => text_between(Some(value), min, max).map(Some),
    }
}

/// One `opencode auth list --format json` row, bounded as `OpenCodeConnectionRows` is.
fn connection_source(row: &Value) -> Result<Option<(String, ModelSource)>, ()> {
    let row = row.as_object().ok_or(())?;
    let id = text_between(row.get("id"), 1, 256)?;
    let name = optional_text(row.get("name"), 1, 256)?;
    let local = match row.get("local") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_bool().ok_or(())?),
    };
    let base_url = optional_text(row.get("baseURL"), 0, 4096)?;
    let connections = row.get("connections").and_then(Value::as_array).ok_or(())?;
    if connections.len() > 128 {
        return Err(());
    }
    let mut types = Vec::new();
    let mut auth_type: Option<String> = None;
    for connection in connections {
        let connection = connection.as_object().ok_or(())?;
        let kind = text_between(connection.get("type"), 0, 256)?;
        let method = optional_text(connection.get("authType"), 0, 256)?
            .or(optional_text(connection.get("method"), 0, 256)?)
            .filter(|method| !method.is_empty());
        types.push(kind);
        if auth_type.is_none() {
            auth_type = method;
        }
    }
    let source = provider_source_with(
        &id,
        &SourceInfo {
            name: name.as_deref(),
            local,
            base_url: base_url.as_deref(),
            types: types.iter().map(String::as_str).collect(),
            auth_type: auth_type.as_deref(),
        },
    );
    // A row with no connection is only a source when it is a local endpoint.
    Ok((!connections.is_empty() || source.kind == ModelSourceKind::Local).then_some((id, source)))
}

/// The providers the CLI reports a connection for (`parseOpenCodeConnections`).
pub fn parse_connections(text: &str) -> Result<Connected, &'static str> {
    let value: Value =
        serde_json::from_str(text).map_err(|_| "Malformed OpenCode connection status")?;
    let rows = value
        .as_array()
        .ok_or("Malformed OpenCode connection status")?;
    if rows.len() > 512 {
        return Err("Too many OpenCode connections");
    }
    let mut connected: Connected = Vec::new();
    for row in rows {
        if let Some((id, source)) = connection_source(row)
            .map_err(|()| "Malformed OpenCode connection status")?
            .filter(|(id, _)| !id.is_empty())
        {
            connected.push((id, source));
        }
    }
    Ok(connected)
}

/// OpenCode Console serves Go from one login, so Go joins as a candidate (`impliedOpenCodeProviders`).
pub fn implied_providers(connected: &Connected) -> Connected {
    let zen = connected.iter().find(|(id, _)| id == "opencode");
    match zen {
        Some((_, source))
            if source.kind != ModelSourceKind::Local
                && !connected.iter().any(|(id, _)| id == "opencode-go") =>
        {
            vec![("opencode-go".to_owned(), provider_source("opencode-go"))]
        }
        _ => Vec::new(),
    }
}

fn looks_like_provider(id: &str) -> bool {
    (1..=256).contains(&id.chars().count())
}

/// A `provider/model` id from the catalog, when the entry names one.
fn metadata_identity(raw: &Value) -> Option<String> {
    let entry = raw.as_object()?;
    let provider = match entry.get("providerID") {
        Some(Value::String(provider)) => provider,
        _ => return None,
    };
    let model = match entry.get("modelID") {
        Some(Value::String(model)) => model,
        _ => return None,
    };
    Some(format!("{provider}/{model}"))
}

fn free_model(provider: &str, model_id: &str) -> bool {
    ["opencode", "opencode-zen"].contains(&provider)
        && (model_id.ends_with("-free") || model_id == "big-pickle")
}

/// The catalog's eligible rows and their per-source outcomes (`normalizeOpenCodeReport`).
#[allow(clippy::result_large_err)]
pub fn build_report(
    payload: &Value,
    instance: &ModelInstance,
    connected: &Connected,
) -> Result<OpenCodeReport, DiscoveryFailure> {
    let envelope = payload.as_object().ok_or_else(malformed)?;
    // The reply's own Location is kept for the normaliser, so a server that answered for
    // another directory is refused instead of being relabelled with this instance's.
    let location = envelope.get("location").cloned().unwrap_or(Value::Null);
    let data = envelope
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(malformed)?;
    if data.len() > 8192 {
        return Err(malformed());
    }
    let implied = implied_providers(connected);
    // The reply's own Location is part of the envelope: a server that answered for
    // another directory is refused once, never relabelled per source.
    if location.get("directory").and_then(Value::as_str) != Some(instance.cwd.as_str()) {
        return Err(DiscoveryFailure {
            code: Some(FailureCode::DiscoveryFailed.as_str().to_owned()),
            message: Some("OpenCode answered for another directory".to_owned()),
            ..DiscoveryFailure::default()
        });
    }
    let errors: Vec<(String, Value)> = match envelope.get("errors") {
        None | Some(Value::Null) => Vec::new(),
        Some(errors) => errors
            .as_array()
            .ok_or_else(malformed)?
            .iter()
            .take(512)
            .filter_map(|error| {
                let error = error.as_object()?;
                let provider = error.get("providerID")?.as_str()?;
                if !looks_like_provider(provider) {
                    return None;
                }
                Some((provider.to_owned(), error.get("error").cloned()?))
            })
            .collect(),
    };
    let mut report = OpenCodeReport::default();
    // Every connected provider has a place, whether or not the catalog listed a row for
    // it: one that listed none is reported as having no models, and one the server failed
    // stays visible so its last good choices are kept and marked stale.
    let mut available: Connected = connected.clone();
    let mut grouped: Vec<(String, Vec<Value>)> = Vec::new();
    for raw in data {
        if let Some(identity) = metadata_identity(raw) {
            report.metadata_ids.insert(identity);
        }
        let Some(provider) = raw
            .as_object()
            .and_then(|entry| entry.get("providerID"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if !looks_like_provider(provider) {
            continue;
        }
        let candidate = implied
            .iter()
            .find(|(id, _)| id == provider)
            .map(|(_, s)| s.clone());
        let source = match candidate {
            Some(source) => source,
            None => {
                if let Some((_, source)) = connected.iter().find(|(id, _)| id == provider) {
                    source.clone()
                } else {
                    let inferred = provider_source(provider);
                    // A provider with no connection joins only when local, or when the
                    // catalog itself prices every tier at zero: an id that merely looks
                    // free is no evidence for a row that carries metadata.
                    if !ace_models::free::free_opencode_model(raw)
                        && inferred.kind != ModelSourceKind::Local
                    {
                        continue;
                    }
                    ModelSource {
                        requires_auth: Some(false),
                        ..inferred
                    }
                }
            }
        };
        if !available.iter().any(|(id, _)| id == provider) {
            available.push((provider.to_owned(), source));
        }
        match grouped.iter_mut().find(|(id, _)| id == provider) {
            Some((_, rows)) => rows.push(raw.clone()),
            None => grouped.push((provider.to_owned(), vec![raw.clone()])),
        }
    }
    // An explicit error takes precedence over any rows the reply carried for that provider:
    // a failed provider keeps its last good choices, never new ones.
    let failed: BTreeSet<String> = errors
        .iter()
        .map(|(provider, _)| provider.clone())
        .collect();
    for (provider, _) in &errors {
        if available.iter().any(|(id, _)| id == provider) {
            continue;
        }
        if let Some((_, source)) = connected.iter().find(|(id, _)| id == provider) {
            available.push((provider.clone(), source.clone()));
        }
    }
    let eligible: HashSet<String> = available
        .iter()
        .map(|(id, _)| id.clone())
        .filter(|id| !failed.contains(id))
        .collect();
    // Each provider is normalized on its own, as the TypeScript's per-source try/catch
    // does: one malformed provider cannot erase the healthy ones or its own last good
    // choices.
    for (provider, source) in available.clone() {
        if let Some((_, error)) = errors.iter().find(|(id, _)| id == &provider) {
            failed_source(&mut report, &provider, &source, failure_from_value(error));
            continue;
        }
        let provider_data: Vec<Value> = grouped
            .iter()
            .find(|(id, _)| id == &provider)
            .map(|(_, rows)| rows.clone())
            .unwrap_or_default();
        let normalized = ace_models::opencode::normalize_opencode_v2(
            &serde_json::json!({
                "location": location,
                "data": provider_data,
                "configuredDefault": envelope.get("configuredDefault").cloned().unwrap_or(Value::Null),
            }),
            instance,
            Some(&eligible),
        );
        let mut rows = match normalized {
            Ok(rows) => rows,
            Err(error) => {
                failed_source(&mut report, &provider, &source, opencode_failure(error));
                continue;
            }
        };
        let mut provider_rows: Vec<CatalogModel> = rows
            .iter_mut()
            .filter_map(|row| {
                let native = row.native_provider_id.as_ref()?.0.0.clone();
                (native == provider).then(|| row.clone())
            })
            .collect();
        if provider_rows.is_empty() {
            report.missing_metadata.insert(provider.clone());
            report.sources.push(SourceStatus {
                source,
                status: SourceState::Fresh,
                last_refreshed_at: None,
                error: Some(discovery_error(
                    None,
                    FailureCode::NoModels,
                    &ErrorContext {
                        provider: Some("opencode"),
                        source: Some(&provider),
                        backend: None,
                    },
                )),
            });
            continue;
        }
        for row in &mut provider_rows {
            let routed = model_source_with(&provider, &row.id.0, source.clone());
            row.source = Some(routed.clone().into());
            if !report
                .sources
                .iter()
                .any(|status| status.source.id.0 == routed.id.0)
            {
                report.sources.push(SourceStatus {
                    source: routed,
                    status: SourceState::Fresh,
                    last_refreshed_at: None,
                    error: None,
                });
            }
        }
        report.models.extend(provider_rows);
    }
    if report.models.len() > 512 {
        return Err(DiscoveryFailure {
            code: Some(FailureCode::ParseFailure.as_str().to_owned()),
            message: Some("Too many connected models".to_owned()),
            ..DiscoveryFailure::default()
        });
    }
    Ok(report)
}

fn malformed() -> DiscoveryFailure {
    DiscoveryFailure {
        code: Some(FailureCode::ParseFailure.as_str().to_owned()),
        message: Some("OpenCode model catalog is malformed".to_owned()),
        ..DiscoveryFailure::default()
    }
}

fn opencode_failure(error: ace_models::opencode::OpenCodeError) -> DiscoveryFailure {
    match error {
        ace_models::opencode::OpenCodeError::LocationMismatch => DiscoveryFailure {
            code: Some(FailureCode::DiscoveryFailed.as_str().to_owned()),
            message: Some("OpenCode answered for another directory".to_owned()),
            ..DiscoveryFailure::default()
        },
        ace_models::opencode::OpenCodeError::TooManyConnectedModels => DiscoveryFailure {
            code: Some(FailureCode::ParseFailure.as_str().to_owned()),
            message: Some("Too many connected models".to_owned()),
            ..DiscoveryFailure::default()
        },
        _ => malformed(),
    }
}

/// One provider's failure: its source keeps its last good rows and is reported stale.
fn failed_source(
    report: &mut OpenCodeReport,
    provider: &str,
    source: &ModelSource,
    failure: DiscoveryFailure,
) {
    let detail = discovery_error(
        Some(&failure),
        FailureCode::DiscoveryFailed,
        &ErrorContext {
            provider: Some("opencode"),
            source: Some(provider),
            backend: None,
        },
    );
    report
        .source_failures
        .push((provider.to_owned(), detail.message.clone()));
    report.sources.push(SourceStatus {
        source: source.clone(),
        status: SourceState::Stale,
        last_refreshed_at: None,
        error: Some(detail),
    });
}

/// The bounded error fields a provider nested in its report, for the classifier.
///
/// The TypeScript hands the thrown value itself to `discoveryError`; the wire only
/// carries JSON, so the same fields are read by shape here: a nested `status` of 503
/// must still classify as unreachable.
fn failure_from_value(value: &Value) -> DiscoveryFailure {
    fn bounded(text: &str) -> String {
        crate::text::utf16_prefix(text, 8192)
    }
    fn status(value: &Value) -> Option<f64> {
        match value {
            Value::Number(number) => number.as_f64(),
            Value::String(text) if text.len() == 3 && text.chars().all(|c| c.is_ascii_digit()) => {
                text.parse().ok()
            }
            _ => None,
        }
    }
    fn read(value: &Value, depth: usize) -> DiscoveryFailure {
        if depth >= 12 {
            return DiscoveryFailure::default();
        }
        match value {
            Value::String(text) => {
                let mut failure = DiscoveryFailure {
                    message: Some(bounded(text)),
                    ..DiscoveryFailure::default()
                };
                // A message that is itself JSON is another diagnostic entry.
                if text.starts_with('{')
                    && let Ok(nested) = serde_json::from_str::<Value>(text)
                {
                    failure.cause = Some(Box::new(read(&nested, depth + 1)));
                }
                failure
            }
            Value::Object(entry) => {
                let text = |key: &str| {
                    entry
                        .get(key)
                        .and_then(Value::as_str)
                        .map(bounded)
                        .filter(|text| !text.is_empty())
                };
                let code = entry.get("code").and_then(|code| match code {
                    Value::String(text) => Some(bounded(text)),
                    Value::Number(number) => Some(number.to_string()),
                    _ => None,
                });
                let nested = |key: &str| {
                    entry
                        .get(key)
                        .map(|nested| Box::new(read(nested, depth + 1)))
                };
                let name = text("name");
                DiscoveryFailure {
                    code,
                    discovery_code: text("discoveryCode"),
                    parse_failure: matches!(name.as_deref(), Some("ZodError" | "SyntaxError")),
                    name,
                    reason: text("reason"),
                    tag: text("_tag"),
                    detail: text("detail"),
                    message: text("message"),
                    // Each field is parsed on its own, so a null `status` falls back to
                    // a usable `statusCode` instead of swallowing it.
                    status: entry
                        .get("status")
                        .and_then(status)
                        .or_else(|| entry.get("statusCode").and_then(status)),
                    cause: nested("cause"),
                    error: nested("error"),
                    data: nested("data"),
                    response: nested("response"),
                    body: nested("body"),
                    ..DiscoveryFailure::default()
                }
            }
            _ => DiscoveryFailure::default(),
        }
    }
    read(value, 0)
}

/// The CLI listing's overflow, naming the provider whose ids did not fit.
#[derive(Debug, Clone)]
pub struct SupplementError {
    pub failure: DiscoveryFailure,
    pub source: Option<String>,
}

/// The `models` listing, filtered by what the account may actually serve.
///
/// Returns the number of ids it rejected, so a caller can log what it dropped.
#[allow(clippy::result_large_err)]
pub fn supplement(
    report: &mut OpenCodeReport,
    listed: Vec<ListedModel>,
    connected: &Connected,
    instance: &ModelInstance,
) -> Result<usize, SupplementError> {
    let implied = implied_providers(connected);
    let mut seen = report.metadata_ids.clone();
    let mut rejected = 0;
    for listed in listed {
        let id = listed.model.id.0.clone();
        if !(3..=256).contains(&id.chars().count())
            || !id.split_once('/').is_some_and(|(provider, model)| {
                !provider.is_empty() && !model.is_empty() && !model.contains(char::is_whitespace)
            })
        {
            rejected += 1;
            continue;
        }
        if seen.contains(&id) {
            continue;
        }
        let provider = id
            .split_once('/')
            .map(|(provider, _)| provider)
            .unwrap_or_default();
        // A provider whose own answer failed keeps no ids from the listing.
        if report.sources.iter().any(|status| {
            status.source.id.0 == provider
                && status
                    .error
                    .as_ref()
                    .is_some_and(|error| error.code != FailureCode::NoModels)
        }) {
            rejected += 1;
            continue;
        }
        let known = connected
            .iter()
            .chain(implied.iter())
            .find(|(known, _)| known == provider)
            .map(|(_, source)| source.clone());
        let inferred = provider_source(provider);
        let model_id = id
            .split_once('/')
            .map(|(_, model)| model)
            .unwrap_or_default();
        // The id heuristic is evidence only for an id-only listing row. A row the CLI
        // printed as JSON metadata is priced by that metadata, so a paid
        // `opencode/*-free` row is not made free by its name.
        let free = listed.id_only && free_model(provider, model_id);
        let declared_free = listed.model.free.as_deref().copied().unwrap_or(false);
        let source = match known {
            Some(source) => model_source_with(provider, &id, source),
            None => {
                if inferred.kind != ModelSourceKind::Local && !free && !declared_free {
                    rejected += 1;
                    continue;
                }
                model_source_with(
                    provider,
                    &id,
                    ModelSource {
                        requires_auth: Some(false),
                        ..inferred
                    },
                )
            }
        };
        if report.models.len() >= 512 {
            return Err(SupplementError {
                failure: DiscoveryFailure {
                    code: Some(FailureCode::ParseFailure.as_str().to_owned()),
                    message: Some("Too many models".to_owned()),
                    ..DiscoveryFailure::default()
                },
                source: Some(provider.to_owned()),
            });
        }
        // The listing row keeps whatever metadata `models` printed; only its source is new.
        let mut model = listed.model;
        model.instance = instance.id.clone().into();
        model.native_provider_id = serde_json::from_value(Value::String(provider.to_owned())).ok();
        model.source = Some(source.clone().into());
        if free {
            model.free = Some(true.into());
        }
        report.models.push(model);
        fill_source(report, source);
        seen.insert(id);
    }
    Ok(rejected)
}

/// The listing filled a source in: it is fresh, and no longer reported as having no models.
fn fill_source(report: &mut OpenCodeReport, source: ModelSource) {
    match report
        .sources
        .iter_mut()
        .find(|status| status.source.id.0 == source.id.0)
    {
        Some(status) => {
            status.status = SourceState::Fresh;
            status.error = None;
        }
        None => report.sources.push(SourceStatus {
            source: source.clone(),
            status: SourceState::Fresh,
            last_refreshed_at: None,
            error: None,
        }),
    }
    report.missing_metadata.remove(&source.id.0);
}

/// A failed CLI supplement marks the sources it could not fill stale, keeping the rows.
///
/// `affected` also names a source that already had rows but could not be completed (the
/// listing overflowed), so its status reports the partial failure instead of staying fresh.
pub fn supplement_failed(
    report: &mut OpenCodeReport,
    cause: &DiscoveryFailure,
    missing: BTreeSet<String>,
    affected: Option<&str>,
) {
    let detail = discovery_error(
        Some(cause),
        FailureCode::DiscoveryFailed,
        &ErrorContext {
            provider: Some("opencode"),
            source: None,
            backend: None,
        },
    );
    let mut stale = missing;
    if let Some(source) = affected {
        stale.insert(source.to_owned());
    }
    for status in &mut report.sources {
        if stale.contains(&status.source.id.0) {
            status.status = SourceState::Stale;
            status.error = Some(detail.clone());
        }
    }
    for source in &stale {
        if report
            .sources
            .iter()
            .all(|status| status.source.id.0 != *source)
        {
            report
                .source_failures
                .push((source.clone(), detail.message.clone()));
        }
    }
}

/// One `opencode models` row, and whether it carried JSON metadata or only the id.
#[derive(Debug, Clone)]
pub struct ListedModel {
    pub model: ace_protocol::generated::CatalogModel,
    pub id_only: bool,
}

/// The CLI's `opencode models` listing: a `provider/model` heading, then its JSON object.
pub fn parse_opencode_listing(
    output: &str,
    instance: &ModelInstance,
) -> Result<Vec<ListedModel>, &'static str> {
    let mut rows = Vec::new();
    let mut heading: Option<String> = None;
    let mut json = String::new();
    let mut bytes = 0;
    for line in output.lines() {
        bytes += line.len() + 1;
        if bytes > 4 * 1024 * 1024 {
            return Err("Model metadata output exceeded limit");
        }
        let trimmed = line.trim();
        if heading.is_none() {
            if trimmed.is_empty() {
                continue;
            }
            let valid = !trimmed.contains(char::is_whitespace)
                && trimmed
                    .split_once('/')
                    .is_some_and(|(provider, model)| !provider.is_empty() && !model.is_empty());
            if !valid {
                return Err("Malformed model heading");
            }
            heading = Some(trimmed.to_owned());
            continue;
        }
        if !json.is_empty()
            && !trimmed.is_empty()
            && !trimmed.starts_with(['{', '}', '"', ']', '['])
            && trimmed.contains('/')
        {
            // A heading with no object after it (the id-only listing).
            let current = heading.take().unwrap_or_default();
            push_listing_row(&mut rows, instance, &current, &json)?;
            json.clear();
            heading = Some(trimmed.to_owned());
            continue;
        }
        if json.is_empty() && trimmed.contains('/') && !trimmed.starts_with('{') {
            let current = heading.take().unwrap_or_default();
            push_listing_row(&mut rows, instance, &current, "")?;
            heading = Some(trimmed.to_owned());
            continue;
        }
        json.push_str(line);
        json.push('\n');
        if line != "}"
            && !(json.lines().count() == 1 && trimmed.starts_with('{') && trimmed.ends_with('}'))
        {
            continue;
        }
        let current = heading.take().unwrap_or_default();
        push_listing_row(&mut rows, instance, &current, &json)?;
        json.clear();
        if rows.len() > 512 {
            return Err("Too many models");
        }
    }
    if let Some(current) = heading.take() {
        push_listing_row(&mut rows, instance, &current, &json)?;
    }
    if rows.len() > 512 {
        return Err("Too many models");
    }
    Ok(rows)
}

fn push_listing_row(
    rows: &mut Vec<ListedModel>,
    instance: &ModelInstance,
    heading: &str,
    json: &str,
) -> Result<(), &'static str> {
    let (provider, model_id) = heading.split_once('/').ok_or("Malformed model heading")?;
    if json.trim().is_empty() {
        let mut model = ace_models::row::base(instance, heading, model_id, &Value::Null);
        model.native_provider_id = serde_json::from_value(Value::String(provider.to_owned())).ok();
        rows.push(ListedModel {
            model,
            id_only: true,
        });
        return Ok(());
    }
    let native: Value = serde_json::from_str(json).map_err(|_| "Malformed model metadata")?;
    let native_provider = native
        .get("providerID")
        .and_then(Value::as_str)
        .unwrap_or(provider);
    let native_id = native.get("id").and_then(Value::as_str).unwrap_or(model_id);
    if format!("{native_provider}/{native_id}") != heading {
        return Err("Model heading mismatch");
    }
    let name = native
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(model_id);
    let mut model = ace_models::row::base(instance, heading, name, &native);
    model.native_provider_id =
        serde_json::from_value(Value::String(native_provider.to_owned())).ok();
    if let Some(context) = native
        .get("limit")
        .and_then(|limit| limit.get("context"))
        .and_then(Value::as_u64)
    {
        model.context_window = serde_json::from_value(Value::from(context)).ok();
    }
    if let Some(input) = native
        .get("capabilities")
        .and_then(|c| c.get("input"))
        .and_then(Value::as_object)
    {
        let modalities: Vec<Value> = input
            .iter()
            .filter(|(_, enabled)| enabled.as_bool() == Some(true))
            .map(|(id, _)| Value::String(id.clone()))
            .collect();
        model.input_modalities =
            serde_json::from_value(Value::Array(modalities)).unwrap_or_else(|_| Vec::new().into());
    }
    let variants: Vec<ace_models::effort::EffortValue<'_>> = native
        .get("variants")
        .and_then(Value::as_object)
        .map(|variants| {
            variants
                .keys()
                .map(|id| ace_models::effort::EffortValue::id(id))
                .collect()
        })
        .unwrap_or_default();
    model.efforts = ace_models::effort::model_efforts(variants).into();
    let status = native.get("status").and_then(Value::as_str).unwrap_or("");
    model.deprecated = (status == "deprecated" || status == "legacy").into();
    model.legacy = Some(ace_models::metadata::legacy_metadata(&native).into());
    if ace_models::metadata::chat_metadata(&native) {
        rows.push(ListedModel {
            model,
            id_only: false,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_null_status_falls_back_to_a_usable_status_code() {
        let failure = failure_from_value(&serde_json::json!({
            "status": null,
            "statusCode": 429,
        }));
        assert_eq!(failure.status, Some(429.0));
        let detail = discovery_error(
            Some(&failure),
            FailureCode::DiscoveryFailed,
            &ErrorContext::default(),
        );
        assert_eq!(
            detail.code,
            FailureCode::RateLimited,
            "the fallback field classifies as rate limited"
        );
    }
}
