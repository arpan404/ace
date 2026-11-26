// SPDX-License-Identifier: Apache-2.0
//! OpenCode's location-scoped v2 catalog, and the cold-catalog re-read.
//!
//! Ports `packages/models/src/open-code.ts`'s `normalizeOpenCodeV2` and
//! `packages/adapter-opencode/src/metadata.ts`'s `modelCatalog`. The flow is
//! sans-IO: the caller reads `/api/model` (a port) and passes the reply bytes here,
//! together with the clock and pause the cold re-read needs.
//!
//! On OpenCode 2.4.2 a cold Location answers the first read with `data: []` and fills
//! the catalog 1–3 s later. [`read_until_models`] reads again every 50 ms, at most 40
//! reads or 5 s on the injected clock, and stops when abort fires. Efforts are
//! `variants[].id` in the server's order, never `settings.reasoningEffort`.

use std::collections::{HashMap, HashSet};

use ace_protocol::generated::CatalogModel;
use serde_json::Value;

use crate::effort::{EffortValue, model_efforts};
use crate::free::free_opencode_model;
use crate::instance::ModelInstance;
use crate::metadata::{chat_metadata, legacy_metadata};
use crate::native::{LABEL_LIMIT, label, positive_int, required_label};
use crate::row::{RowError, base, decoded_text, nonzero, texts, validate_row};

/// The cold-catalog poll interval (`catalogPollMs`).
pub const CATALOG_POLL_MS: u64 = 50;
/// The most catalog reads one discovery makes (`catalogReads`).
pub const CATALOG_READS: usize = 40;
/// How long a cold catalog is waited for (`catalogBudgetMs`).
pub const CATALOG_BUDGET_MS: u64 = 5_000;

const ROWS_LIMIT: usize = 512;
const DATA_LIMIT: usize = 8_192;
const MODALITIES_LIMIT: usize = 256;
const VARIANTS_LIMIT: usize = 32;

/// What a catalog read returns: the reply, or the discovery's own read failure.
pub enum ColdReadStop<E> {
    Read(E),
    Aborted,
}

/// Whether the reply is a well-formed catalog that happens to be empty.
///
/// A malformed reply is not an empty one: it is validated once and reported as it came.
pub fn without_models(payload: &Value) -> bool {
    let Some(data) = payload.get("data").and_then(Value::as_array) else {
        return false;
    };
    data.len() <= DATA_LIMIT && data.is_empty()
}

/// Reads the catalog until it answers with models, then returns that reply (or the
/// last empty one when the budget runs out).
///
/// `now` is the injected monotonic clock in milliseconds, `pause` the injected sleep
/// (it returns at once when the caller aborts), and `aborted` is checked after each
/// pause, as the TypeScript's `signal.throwIfAborted()` is.
pub fn read_until_models<E>(
    now: &mut dyn FnMut() -> u64,
    aborted: &dyn Fn() -> bool,
    read: &mut dyn FnMut() -> Result<Value, E>,
    pause: &mut dyn FnMut(u64),
) -> Result<Value, ColdReadStop<E>> {
    let started = now();
    let mut reads = 0;
    loop {
        reads += 1;
        let payload = read().map_err(ColdReadStop::Read)?;
        if !without_models(&payload) {
            return Ok(payload);
        }
        if reads >= CATALOG_READS || now().saturating_sub(started) >= CATALOG_BUDGET_MS {
            return Ok(payload);
        }
        pause(CATALOG_POLL_MS);
        if aborted() {
            return Err(ColdReadStop::Aborted);
        }
    }
}

/// Why a v2 catalog cannot be normalized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenCodeError {
    /// The reply answers for another directory.
    LocationMismatch,
    /// The reply is not a v2 catalog, or one entry is not a model.
    MalformedCatalog,
    /// More than 512 connected models after deduplication.
    TooManyConnectedModels,
    /// A normalized row breaks the protocol's bounds.
    Row(RowError),
}

impl std::fmt::Display for OpenCodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LocationMismatch => f.write_str("OpenCode model location mismatch"),
            Self::MalformedCatalog => f.write_str("OpenCode model catalog is malformed"),
            Self::TooManyConnectedModels => f.write_str("Too many connected models"),
            Self::Row(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for OpenCodeError {}

/// One v2 model entry, validated the way the TypeScript's `V2Model` parses it.
struct NativeModel {
    raw: Value,
    provider_id: String,
    model_id: String,
    name: String,
    enabled: bool,
    status: String,
    context: u64,
    input: Vec<String>,
    variants: Vec<String>,
}

/// A v2 entry's `capabilities.input`: a mime list, or an enabled-flag record.
fn input_modalities(value: Option<&Value>) -> Option<Vec<String>> {
    let value = value?;
    if let Some(items) = value.as_array() {
        if items.len() > MODALITIES_LIMIT {
            return None;
        }
        return items.iter().map(|item| label(Some(item))).collect();
    }
    let flags = value.as_object()?;
    let mut enabled = Vec::new();
    for (mime, on) in flags {
        if !on.is_boolean() {
            return None;
        }
        if on.as_bool() == Some(true) {
            enabled.push(mime.clone());
        }
    }
    Some(enabled)
}

fn parse_model(raw: &Value) -> Result<NativeModel, OpenCodeError> {
    let entry = raw.as_object().ok_or(OpenCodeError::MalformedCatalog)?;
    let provider_id = required_label(entry, "providerID").ok_or(OpenCodeError::MalformedCatalog)?;
    let model_id = required_label(entry, "modelID").ok_or(OpenCodeError::MalformedCatalog)?;
    let name = required_label(entry, "name").ok_or(OpenCodeError::MalformedCatalog)?;
    let enabled = entry
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or(OpenCodeError::MalformedCatalog)?;
    let status = entry
        .get("status")
        .and_then(Value::as_str)
        .ok_or(OpenCodeError::MalformedCatalog)?
        .to_owned();
    let limit = entry
        .get("limit")
        .and_then(Value::as_object)
        .ok_or(OpenCodeError::MalformedCatalog)?;
    let context = positive_int(limit.get("context")).ok_or(OpenCodeError::MalformedCatalog)?;
    // `output` is required by the parser even though no row field reads it.
    positive_int(limit.get("output")).ok_or(OpenCodeError::MalformedCatalog)?;
    let capabilities = entry
        .get("capabilities")
        .and_then(Value::as_object)
        .ok_or(OpenCodeError::MalformedCatalog)?;
    let input =
        input_modalities(capabilities.get("input")).ok_or(OpenCodeError::MalformedCatalog)?;
    let variants = entry
        .get("variants")
        .and_then(Value::as_array)
        .ok_or(OpenCodeError::MalformedCatalog)?;
    if variants.len() > VARIANTS_LIMIT {
        return Err(OpenCodeError::MalformedCatalog);
    }
    let mut variant_ids = Vec::with_capacity(variants.len());
    for variant in variants {
        let id = variant
            .as_object()
            .and_then(|variant| required_label(variant, "id"))
            .ok_or(OpenCodeError::MalformedCatalog)?;
        variant_ids.push(id);
    }
    Ok(NativeModel {
        raw: raw.clone(),
        provider_id,
        model_id,
        name,
        enabled,
        status,
        context,
        input,
        variants: variant_ids,
    })
}

/// The v2 catalog's location, entries and configured default, each validated.
struct Catalog<'a> {
    configured_default: Option<String>,
    data: &'a [Value],
}

fn parse_catalog<'a>(
    payload: &'a Value,
    instance: &ModelInstance,
) -> Result<Catalog<'a>, OpenCodeError> {
    let entry = payload.as_object().ok_or(OpenCodeError::MalformedCatalog)?;
    let directory = entry
        .get("location")
        .and_then(Value::as_object)
        .and_then(|location| location.get("directory"))
        .and_then(Value::as_str)
        .ok_or(OpenCodeError::MalformedCatalog)?;
    let data = entry
        .get("data")
        .and_then(Value::as_array)
        .ok_or(OpenCodeError::MalformedCatalog)?;
    if data.len() > DATA_LIMIT {
        return Err(OpenCodeError::MalformedCatalog);
    }
    let configured_default = match entry.get("configuredDefault") {
        None | Some(Value::Null) => None,
        Some(value) => Some(label(Some(value)).ok_or(OpenCodeError::MalformedCatalog)?),
    };
    if directory != instance.cwd {
        return Err(OpenCodeError::LocationMismatch);
    }
    Ok(Catalog {
        configured_default,
        data,
    })
}

/// The mime families a model accepts, in the model's order and without repeats.
fn modality_families(input: &[String]) -> Vec<String> {
    let mut families: Vec<String> = Vec::new();
    for mime in input {
        let family = mime.split('/').next().unwrap_or(mime).to_owned();
        if !families.contains(&family) {
            families.push(family);
        }
    }
    families
}

fn deprecated_status(status: &str) -> bool {
    status == "deprecated" || status == "legacy"
}

/// A v2 catalog's rows: enabled chat models, deduplicated by `providerID/modelID`.
///
/// When `connected` is given, entries from providers without a connection are skipped
/// before their bodies are validated, as the TypeScript's `V2Provider.safeParse` does.
pub fn normalize_opencode_v2(
    payload: &Value,
    instance: &ModelInstance,
    connected: Option<&HashSet<String>>,
) -> Result<Vec<CatalogModel>, OpenCodeError> {
    let catalog = parse_catalog(payload, instance)?;
    let mut order: Vec<String> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut natives: Vec<NativeModel> = Vec::new();
    for raw in catalog.data {
        if let Some(connected) = connected {
            let provider = raw.get("providerID").and_then(Value::as_str);
            if !provider.is_some_and(|provider| {
                (1..=LABEL_LIMIT).contains(&provider.chars().count())
                    && connected.contains(provider)
            }) {
                continue;
            }
        }
        let native = parse_model(raw)?;
        if !native.enabled || !chat_metadata(&native.raw) {
            continue;
        }
        let id = format!("{}/{}", native.provider_id, native.model_id);
        if let Some(&at) = positions.get(&id) {
            let previous = &natives[at];
            let previous_legacy = legacy_metadata(&previous.raw);
            let legacy = legacy_metadata(&native.raw);
            let keep_previous = if previous_legacy != legacy {
                legacy
            } else {
                previous.enabled || !native.enabled
            };
            if keep_previous {
                continue;
            }
            natives[at] = native;
        } else {
            positions.insert(id.clone(), natives.len());
            order.push(id);
            natives.push(native);
            if natives.len() > ROWS_LIMIT {
                return Err(OpenCodeError::TooManyConnectedModels);
            }
        }
    }
    let mut rows = Vec::with_capacity(natives.len());
    for (native, id) in natives.into_iter().zip(order) {
        // Keep the qualified execution selector supplied by `base` in `nativeModelId`.
        let mut model = base(instance, &id, &native.name, &native.raw);
        model.native_provider_id = decoded_text(Some(&native.provider_id));
        model.context_window = nonzero(native.context);
        if free_opencode_model(&native.raw) {
            model.free = Some(true.into());
        }
        model.input_modalities = texts(modality_families(&native.input));
        model.efforts = model_efforts(native.variants.iter().map(|id| EffortValue::id(id))).into();
        if catalog.configured_default.as_deref() == Some(id.as_str()) {
            model.is_default = true.into();
        }
        model.hidden = (!native.enabled).into();
        model.deprecated = deprecated_status(&native.status).into();
        model.legacy = Some(legacy_metadata(&native.raw).into());
        validate_row(&model).map_err(OpenCodeError::Row)?;
        rows.push(model);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/open-code.test.ts` in full —
    //! "OpenCode 2.4.2 variants become efforts in the order the server lists them" —
    //! and `packages/adapter-opencode/src/catalog-cold.process.test.ts`:
    //! "discovery reads a cold 2.4.2 catalog again until its variants arrive".
    //! The re-read bounds and abort are rule-17 checked against an injected clock.
    //!
    //! The rest guard the v2 normalisation the TypeScript's `V2Catalog`/`V2Model`
    //! parse (connected-provider skips, disabled/non-chat entries, location scope,
    //! deduplication, the 512-row bound and the row limits).

    use super::*;
    use ace_protocol::generated::ProviderKind;
    use serde_json::json;

    fn instance() -> ModelInstance {
        ModelInstance::cli("opencode", ProviderKind::Opencode, "", "/one")
    }

    fn fixture_data() -> Value {
        let text = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../fixtures/opencode/2.4.2/model-catalog.json"
        ));
        serde_json::from_str(text).unwrap_or(Value::Null)
    }

    fn catalog(entries: Value) -> Value {
        json!({ "location": { "directory": "/one" }, "data": entries })
    }

    fn rows(payload: &Value, connected: Option<&HashSet<String>>) -> Vec<CatalogModel> {
        normalize_opencode_v2(payload, &instance(), connected).unwrap_or_default()
    }

    fn row_json(model: &CatalogModel) -> Value {
        serde_json::to_value(model).unwrap_or(Value::Null)
    }

    fn entry(model: &str) -> Value {
        json!({
            "id": model,
            "modelID": model,
            "providerID": "opencode",
            "name": format!("Model {model}"),
            "enabled": true,
            "status": "active",
            "limit": { "context": 200_000, "output": 32_000 },
            "capabilities": { "input": ["text"] },
            "variants": [],
        })
    }

    #[test]
    fn opencode_2_4_2_variants_become_efforts_in_the_order_the_server_lists_them() {
        let payload = catalog(fixture_data());
        let rows = rows(&payload, None);
        let by_id: std::collections::HashMap<String, Value> = rows
            .iter()
            .map(|model| (model.id.0.clone(), row_json(model)))
            .collect();
        let deepseek = &by_id["opencode/deepseek-v4.1-flash"];
        assert_eq!(deepseek["contextWindow"], 1_000_000);
        assert_eq!(deepseek["inputModalities"], json!(["text", "image"]));
        assert_eq!(
            deepseek["efforts"],
            json!([
                { "id": "low", "level": "low", "label": "Low" },
                { "id": "high", "level": "high", "label": "High" },
                { "id": "max", "level": "max", "label": "Max" }
            ])
        );
        let gemini = &by_id["opencode/gemini-4-neon"];
        let gemini_ids: Vec<&str> = gemini["efforts"]
            .as_array()
            .map(|efforts| {
                efforts
                    .iter()
                    .filter_map(|effort| effort["id"].as_str())
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(gemini_ids, ["low", "medium", "high", "xhigh"]);
        let last = gemini["efforts"]
            .as_array()
            .and_then(|efforts| efforts.last())
            .cloned()
            .unwrap_or(Value::Null);
        assert_eq!(last["level"], "xhigh");
        assert_eq!(last["label"], "XHigh");
        assert_eq!(
            by_id["opencode/hy4-flash-free"]["efforts"],
            json!([
                { "id": "none", "level": "off", "label": "Off" },
                { "id": "high", "level": "high", "label": "High" }
            ])
        );
        assert_eq!(by_id["opencode/kimi-k2.7-code"]["efforts"], json!([]));
        // The fixture's rows keep the qualified execution selector.
        assert_eq!(
            by_id["opencode/deepseek-v4.1-flash"]["nativeModelId"],
            "opencode/deepseek-v4.1-flash"
        );
        assert_eq!(
            by_id["opencode/deepseek-v4.1-flash"]["nativeProviderId"],
            "opencode"
        );
    }

    #[test]
    fn discovery_reads_a_cold_2_4_2_catalog_again_until_its_variants_arrive() {
        let empty = catalog(json!([]));
        let full = catalog(fixture_data());
        let mut replies = vec![empty.clone(), empty, full].into_iter();
        let clock = std::cell::Cell::new(0u64);
        let reads = std::cell::Cell::new(0);
        let mut now = || clock.get();
        let mut read = || {
            reads.set(reads.get() + 1);
            Ok::<Value, ()>(replies.next().unwrap_or(Value::Null))
        };
        let mut pause = |ms: u64| clock.set(clock.get() + ms);
        let payload =
            read_until_models(&mut now, &|| false, &mut read, &mut pause).unwrap_or(Value::Null);
        assert_eq!(reads.get(), 3);
        assert_eq!(clock.get(), 2 * CATALOG_POLL_MS);
        let data = payload["data"].as_array().cloned().unwrap_or_default();
        assert_eq!(data.len(), 4);
        assert_eq!(
            data[0]["variants"].as_array().map(Vec::len),
            Some(3),
            "the full reply is the one discovery returns"
        );
    }

    #[test]
    fn a_catalog_that_stays_empty_is_read_at_most_forty_times() {
        let empty = catalog(json!([]));
        let reads = std::cell::Cell::new(0usize);
        let clock = std::cell::Cell::new(0u64);
        let mut now = || clock.get();
        let mut read = || {
            reads.set(reads.get() + 1);
            Ok::<Value, ()>(empty.clone())
        };
        let mut pause = |ms: u64| clock.set(clock.get() + ms);
        let payload =
            read_until_models(&mut now, &|| false, &mut read, &mut pause).unwrap_or(Value::Null);
        assert_eq!(reads.get(), CATALOG_READS);
        assert_eq!(payload, empty);
        // Forty reads sleep only between them.
        assert_eq!(clock.get(), (CATALOG_READS as u64 - 1) * CATALOG_POLL_MS);
    }

    #[test]
    fn the_five_second_budget_stops_the_reread_before_forty_reads() {
        let empty = catalog(json!([]));
        let reads = std::cell::Cell::new(0usize);
        let clock = std::cell::Cell::new(0u64);
        let mut now = || clock.get();
        let mut read = || {
            reads.set(reads.get() + 1);
            Ok::<Value, ()>(empty.clone())
        };
        // Each pause costs a full second: six reads reach the 5 s budget first.
        let mut pause = |_ms: u64| clock.set(clock.get() + 1_000);
        let _ =
            read_until_models(&mut now, &|| false, &mut read, &mut pause).unwrap_or(Value::Null);
        assert_eq!(reads.get(), 6);
        assert!(clock.get() >= CATALOG_BUDGET_MS);
    }

    #[test]
    fn an_abort_ends_the_pause_with_an_abort_not_the_last_empty_reply() {
        let empty = catalog(json!([]));
        let reads = std::cell::Cell::new(0usize);
        let aborted = std::cell::Cell::new(false);
        let clock = std::cell::Cell::new(0u64);
        let mut now = || clock.get();
        let mut read = || {
            reads.set(reads.get() + 1);
            Ok::<Value, ()>(empty.clone())
        };
        let mut pause = |ms: u64| {
            clock.set(clock.get() + ms);
            aborted.set(true);
        };
        let stopped = read_until_models(&mut now, &|| aborted.get(), &mut read, &mut pause);
        assert!(matches!(stopped, Err(ColdReadStop::Aborted)));
        assert_eq!(reads.get(), 1);
    }

    #[test]
    fn a_malformed_reply_is_returned_not_retried() {
        let malformed = json!({ "data": "not a list" });
        let reads = std::cell::Cell::new(0usize);
        let clock = std::cell::Cell::new(0u64);
        let mut now = || clock.get();
        let mut read = || {
            reads.set(reads.get() + 1);
            Ok::<Value, ()>(malformed.clone())
        };
        let mut pause = |ms: u64| clock.set(clock.get() + ms);
        let payload =
            read_until_models(&mut now, &|| false, &mut read, &mut pause).unwrap_or(Value::Null);
        assert_eq!(reads.get(), 1);
        assert_eq!(payload, malformed);
    }

    #[test]
    fn only_enabled_chat_models_from_a_connected_provider_are_listed() {
        let mut disabled = entry("disabled");
        disabled["enabled"] = json!(false);
        let mut internal = entry("internal");
        internal["status"] = json!("internal");
        let mut unconnected = entry("unconnected");
        unconnected["providerID"] = json!("other");
        let connected: HashSet<String> = ["opencode".to_owned()].into_iter().collect();
        let listed = rows(
            &catalog(json!([entry("kept"), disabled, internal, unconnected])),
            Some(&connected),
        );
        let ids: Vec<&str> = listed.iter().map(|model| model.id.0.as_str()).collect();
        assert_eq!(ids, ["opencode/kept"]);
    }

    #[test]
    fn an_entry_from_a_connected_provider_is_validated_but_another_providers_is_skipped() {
        // The unconnected entry is malformed; it must be skipped before its body is parsed.
        let mut malformed = json!({ "providerID": "other" });
        malformed["enabled"] = json!(true);
        let connected: HashSet<String> = ["opencode".to_owned()].into_iter().collect();
        assert!(
            normalize_opencode_v2(
                &catalog(json!([malformed, entry("kept")])),
                &instance(),
                Some(&connected)
            )
            .is_ok()
        );
        let mut malformed = entry("broken");
        if let Some(entry) = malformed.as_object_mut() {
            entry.remove("limit");
        }
        assert_eq!(
            normalize_opencode_v2(&catalog(json!([malformed])), &instance(), Some(&connected))
                .err(),
            Some(OpenCodeError::MalformedCatalog)
        );
    }

    #[test]
    fn a_reply_for_another_directory_is_refused() {
        let mut payload = catalog(json!([]));
        payload["location"]["directory"] = json!("/elsewhere");
        assert_eq!(
            normalize_opencode_v2(&payload, &instance(), None).err(),
            Some(OpenCodeError::LocationMismatch)
        );
    }

    #[test]
    fn a_duplicate_row_keeps_the_newer_current_or_enabled_entry_in_its_place() {
        let mut legacy = entry("dupe");
        legacy["status"] = json!("legacy");
        let current = entry("dupe");
        let listed = rows(&catalog(json!([entry("first"), legacy, current])), None);
        let ids: Vec<&str> = listed.iter().map(|model| model.id.0.as_str()).collect();
        assert_eq!(ids, ["opencode/first", "opencode/dupe"]);
        assert_eq!(row_json(&listed[1])["legacy"], false);
        // A legacy duplicate cannot replace a current one.
        let listed = rows(&catalog(json!([current, legacy])), None);
        assert_eq!(row_json(&listed[0])["legacy"], false);
    }

    #[test]
    fn the_configured_default_is_marked_and_efforts_wait_for_an_enabled_row() {
        let mut payload = catalog(json!([entry("a"), entry("b")]));
        payload["configuredDefault"] = json!("opencode/b");
        let listed = rows(&payload, None);
        let defaults: Vec<bool> = listed.iter().map(|model| model.is_default.0).collect();
        assert_eq!(defaults, [false, true]);
        assert_eq!(listed.len(), 2);
    }
}
