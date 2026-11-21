//! The format's JSON Schemas (ADR 0201 §4), written from the readers' own lists and bounds into
//! `spade/spec/schemas/` and published at `https://spec.acehq.dev/1.0/<name>`. A schema decides
//! only what JSON Schema can say alone: every rule marked `schema` in [`crate::rule`]. What needs
//! another file, the runtime's build or a comparison across fields stays the reader's. Unknown
//! fields of `bot.json` are allowed, as a reader keeps them.

use serde_json::{Map, Value, json};

use crate::effect::{self, Effect, ceiling::DECLARABLE, runtime};
use crate::package::{code, contract, contract_files, manifest as m, scenario, surfaces};
use crate::schema as subset;
use crate::tools::Risk;

/// Where the schemas live once published.
pub const BASE: &str = "https://spec.acehq.dev/1.0/";
const DRAFT: &str = "https://json-schema.org/draft/2020-12/schema";

/// Each schema by its file name.
pub fn all() -> Vec<(&'static str, Value)> {
    vec![
        ("bot.schema.json", bot()),
        ("contract.schema.json", standalone("contract", "A contract")),
        ("surface.schema.json", standalone("surface", "A surface")),
        ("card.schema.json", card()),
        ("scenario.schema.json", scenario_schema()),
    ]
}

fn head(name: &str, title: &str) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("$schema".into(), json!(DRAFT));
    out.insert("$id".into(), json!(format!("{BASE}{name}")));
    out.insert(
        "title".into(),
        json!(format!("Spade Agent Format {}: {title}", super::VERSION)),
    );
    out
}

/// One of `bot.json`'s definitions as a schema of its own, with every definition it reaches.
fn standalone(def: &str, title: &str) -> Value {
    let mut out = head(&format!("{def}.schema.json"), title);
    out.insert("$ref".into(), json!(format!("#/$defs/{def}")));
    out.insert("$defs".into(), defs());
    Value::Object(out)
}

/// `bot.json` at version 3.
pub fn bot() -> Value {
    let mut properties = Map::new();
    let string = |most: usize| json!({ "type": "string", "maxLength": most });
    let list =
        |most: usize, items: Value| json!({ "type": "array", "maxItems": most, "items": items });
    let named_text = |most: usize| json!({ "type": "string", "maxLength": most, "pattern": "\\S" });
    let pairs = [
        ("$schema", json!({ "type": "string" })),
        ("format", json!({ "const": m::FORMAT })),
        ("version", json!({ "const": 3 })),
        (
            "spec",
            json!({ "type": "string", "pattern": format!("^{}\\.[0-9]+$", major()) }),
        ),
        (
            "requires",
            json!({ "type": "object", "properties": {
                "runtime": { "type": "string", "enum": [m::RUNTIME] },
                "spade": { "type": "string" },
            } }),
        ),
        ("name", named_text(m::NAME_CHARS)),
        ("blurb", string(m::BLURB_CHARS)),
        ("task", json!({ "type": "string" })),
        ("face", json!({ "type": "object" })),
        (
            "style",
            json!({ "type": "object", "required": ["accent"], "properties": {
                "accent": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" } } }),
        ),
        ("personality", json!({ "type": "object" })),
        ("model", json!({ "enum": ["fast", "capable"] })),
        (
            "uses",
            json!({ "type": "array", "items": { "enum": runtime::Module::ALL.map(runtime::Module::name) } }),
        ),
        (
            "triggers",
            list(m::MOST_TRIGGERS, json!({ "$ref": "#/$defs/trigger" })),
        ),
        ("skills", list(m::MOST_REFS, json!({ "type": "string" }))),
        ("plugins", list(m::MOST_REFS, json!({ "type": "string" }))),
        (
            "needs",
            json!({ "type": "object", "properties": {
                "tools": list(m::MOST_TOOLS, json!({ "type": "string", "maxLength": 64, "pattern": "^[a-z][a-z0-9_]*$" })),
                "connectors": { "type": "array" },
            } }),
        ),
        (
            "effects",
            list(m::MOST_EFFECTS, json!({ "$ref": "#/$defs/effect" })),
        ),
        ("limits", limits()),
        (
            "tests",
            list(
                m::MOST_TESTS,
                json!({ "type": "string", "pattern": "^tests/[A-Za-z0-9._-]+\\.json$" }),
            ),
        ),
        (
            "notes",
            list(
                m::MOST_NOTES,
                json!({ "type": "string", "maxLength": m::NOTE_CHARS }),
            ),
        ),
        (
            "pricing",
            json!({ "type": "object", "properties": { "kind": { "const": "free" } } }),
        ),
        (
            "surfaces",
            list(
                surfaces::MOST_SURFACES,
                json!({ "$ref": "#/$defs/surface" }),
            ),
        ),
        (
            "contracts",
            list(
                contract::MOST_CONTRACTS,
                json!({ "$ref": "#/$defs/contract" }),
            ),
        ),
        (
            "code",
            list(code::MOST_COMPONENTS, json!({ "$ref": "#/$defs/code" })),
        ),
    ];
    for (field, schema) in pairs {
        properties.insert(field.to_owned(), schema);
    }
    // Identity and executions refuse the whole file: present at all, the schema fails.
    for field in m::IDENTITY.iter().chain(&m::EXECUTIONS) {
        properties.insert((*field).to_owned(), Value::Bool(false));
    }
    let mut out = head("bot.schema.json", "bot.json");
    out.insert("type".into(), json!("object"));
    out.insert("required".into(), json!(["format", "version", "name"]));
    out.insert("properties".into(), Value::Object(properties));
    out.insert("$defs".into(), defs());
    Value::Object(out)
}

fn major() -> &'static str {
    super::VERSION
        .split_once('.')
        .map_or(super::VERSION, |(major, _)| major)
}

fn limits() -> Value {
    json!({ "type": "object", "properties": {
        "spend_alert": { "type": "object", "properties": {
            "usd_per_day": { "type": "number", "minimum": 0, "maximum": m::MOST_SPEND_ALERT_USD } } },
        "workers_at_once": { "type": "integer", "minimum": 1, "maximum": m::MOST_WORKERS_AT_ONCE },
        "workspace_mb": { "type": "integer", "minimum": 1, "maximum": m::MOST_WORKSPACE_MB },
    } })
}

fn defs() -> Value {
    json!({
        "trigger": trigger(),
        "effect": effect_def(),
        "contract": contract_def(),
        "surface": surface_def(),
        "action": action_def(),
        "schema": subset_def(),
        "code": code_def(),
    })
}

/// A component's entry (ADR 0203): its shape and bounds. That its file matches its name, that
/// its world is one this runtime runs, that `http` comes with network hosts and that the binary
/// imports what it lists are the reader's.
fn code_def() -> Value {
    let mut worlds = vec![code::WORLD];
    worlds.extend(code::LATER_WORLDS);
    let imports: Vec<&str> = code::Import::ALL.iter().map(|i| i.name()).collect();
    let name = format!("^[a-z][a-z0-9]{{0,{}}}$", code::NAME_CHARS - 1);
    let file = format!("^code/[a-z][a-z0-9]{{0,{}}}\\.wasm$", code::NAME_CHARS - 1);
    json!({
        "type": "object",
        "required": ["name", "file", "world", "imports", "why"],
        "properties": {
            "name": { "type": "string", "pattern": name },
            "file": { "type": "string", "pattern": file },
            "world": { "enum": worlds },
            "imports": { "type": "array", "uniqueItems": true, "items": { "enum": imports } },
            "why": { "type": "string", "minLength": 1, "maxLength": code::WHY_CHARS, "pattern": "\\S" },
            "timeout_s": { "type": "integer", "minimum": 1, "maximum": code::MOST_TIMEOUT_S },
            "memory_mb": { "type": "integer", "minimum": 1, "maximum": code::MOST_MEMORY_MB },
        },
    })
}

fn trigger() -> Value {
    let routine = json!({ "required": ["name", "instruction"], "properties": {
        "name": { "type": "string", "minLength": 1, "maxLength": crate::routine::NAME_CHARS },
        "instruction": { "type": "string", "minLength": 1, "maxLength": crate::routine::INSTRUCTION_CHARS },
    } });
    let events: Vec<&str> = m::ACE_EVENTS.iter().map(|(word, _)| *word).collect();
    json!({
        "type": "object",
        "required": ["kind"],
        "properties": { "kind": { "type": "string" } },
        "allOf": [
            { "if": { "properties": { "kind": { "enum": ["schedule", "event", "webhook"] } } }, "then": routine },
            { "if": { "properties": { "kind": { "const": "schedule" } } }, "then": { "required": ["schedule"] } },
            { "if": { "properties": { "kind": { "const": "event" } } },
              "then": { "required": ["event"], "properties": { "event": { "enum": events } } } },
            { "if": { "properties": { "kind": { "const": "mention" } } },
              "then": { "properties": { "in": { "type": "array", "items": { "enum": ["threads", "clubs"] } } } } },
        ],
    })
}

/// The built-in tools a `tool` grant never names: each sends or pays in the person's name.
fn never_granted_tools() -> Vec<&'static str> {
    runtime::TOOLS
        .iter()
        .map(|tool| tool.name)
        .filter(|name| {
            effect::never_granted(effect::builtin(name, Risk::Write)).is_some()
                && effect::builtin(name, Risk::Write).is_some()
        })
        .collect()
}

fn effect_def() -> Value {
    let mut words: Vec<&str> = vec![Effect::Read.name(), Effect::WriteLocal.name()];
    words.extend(DECLARABLE.iter().map(|e| e.name()));
    let own = json!({ "enum": [Effect::Read.name(), Effect::WriteLocal.name()] });
    json!({
        "type": "object",
        "required": ["effect"],
        "properties": {
            "effect": { "enum": words },
            "why": { "type": "string", "minLength": 1, "maxLength": m::WHY_CHARS, "pattern": "\\S" },
            "hosts": { "type": "array", "minItems": 1, "maxItems": m::MOST_HOSTS, "items": { "type": "string" } },
            "grant": {
                "type": "object",
                "required": ["kind"],
                "properties": { "kind": { "enum": ["drive_site", "drive_app", "tool"] } },
                "if": { "properties": { "kind": { "const": "tool" } } },
                "then": { "required": ["tool"], "properties": { "tool": { "type": "string", "not": { "enum": never_granted_tools() } } } },
            },
        },
        "not": { "required": ["hosts", "grant"] },
        "allOf": [
            // Every bot reads and writes its own folder: declaring that says nothing more.
            { "if": { "properties": { "effect": { "not": own } } }, "then": { "required": ["why"] } },
            { "if": { "properties": { "effect": { "not": { "const": Effect::Network.name() } } } },
              "then": { "not": { "required": ["hosts"] } } },
            { "if": { "properties": { "effect": { "not": { "enum": [Effect::Network.name(), Effect::Publish.name()] } } } },
              "then": { "not": { "required": ["grant"] } } },
        ],
    })
}

fn contract_def() -> Value {
    let mut words: Vec<&str> = vec![Effect::Read.name(), Effect::WriteLocal.name()];
    words.extend(DECLARABLE.iter().map(|e| e.name()));
    let mut properties = Map::new();
    properties.insert(
        "name".into(),
        json!({ "type": "string", "pattern": "^[a-z][a-z0-9_]{0,63}$" }),
    );
    properties.insert(
        "summary".into(),
        json!({ "type": "string", "maxLength": contract::SUMMARY_CHARS, "pattern": "\\S" }),
    );
    properties.insert("input".into(), json!({ "$ref": "#/$defs/schema" }));
    properties.insert("output".into(), json!({ "$ref": "#/$defs/schema" }));
    properties.insert(
        "effects".into(),
        json!({ "type": "array", "items": { "enum": words } }),
    );
    properties.insert(
        "examples".into(),
        json!({ "type": "array", "maxItems": contract::MOST_EXAMPLES,
                "items": { "type": "object", "required": ["input", "output"] } }),
    );
    properties.insert(
        "file".into(),
        json!({ "type": "string", "pattern": "^contracts/[a-z0-9][a-z0-9_-]{0,63}\\.json$" }),
    );
    debug_assert!(contract_files::schema_path("contracts/a.json"));
    debug_assert!(contract::FIELDS.iter().all(|f| properties.contains_key(*f)));
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "summary"],
        "properties": properties,
        // Its schemas are in bot.json or in its file, never both.
        "if": { "required": ["file"] },
        "then": { "not": { "anyOf": [{ "required": ["input"] }, { "required": ["output"] }] } },
        "else": { "required": ["input", "output"] },
    })
}

fn surface_def() -> Value {
    json!({
        "type": "object",
        "required": ["id", "kind"],
        "properties": {
            "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,39}$" },
            "kind": { "enum": ["card", "panel"] },
            "file": { "type": "string" },
            "title": { "type": "string", "maxLength": surfaces::TITLE_CHARS, "pattern": "\\S" },
            "state": { "$ref": "#/$defs/schema" },
            "actions": { "type": "array", "maxItems": surfaces::MOST_ACTIONS, "items": { "$ref": "#/$defs/action" } },
        },
        "allOf": [
            { "if": { "properties": { "kind": { "const": "card" } } },
              "then": { "required": ["file"], "properties": { "file": { "pattern": "^cards/[A-Za-z0-9._-]+\\.json$" } } } },
            { "if": { "properties": { "kind": { "const": "panel" } } },
              "then": { "required": ["file", "title"], "properties": { "file": { "pattern": "^panels/[a-z0-9][a-z0-9-]*/index\\.html$" } } } },
        ],
    })
}

fn action_def() -> Value {
    json!({
        "type": "object",
        "required": ["name"],
        "properties": {
            "name": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,39}$" },
            "label": { "type": "string", "maxLength": surfaces::LABEL_CHARS, "pattern": "\\S" },
            "value": { "$ref": "#/$defs/schema" },
            "confirm": { "type": "boolean" },
        },
    })
}

/// The bounded schema subset, as a schema: its kinds, each with only its own keywords.
fn subset_def() -> Value {
    let me = json!({ "$ref": "#/$defs/schema" });
    let count =
        |least: u64, most: u64| json!({ "type": "integer", "minimum": least, "maximum": most });
    let text = json!({ "type": "string", "maxLength": subset::DESCRIPTION_CHARS });
    let mut properties = Map::new();
    let pairs = [
        (
            "type",
            json!({ "enum": ["object", "string", "number", "integer", "boolean", "array"] }),
        ),
        ("description", text.clone()),
        ("title", text),
        (
            "properties",
            json!({ "type": "object", "maxProperties": subset::MOST_FIELDS,
                    "propertyNames": { "pattern": "^[A-Za-z0-9_]{1,64}$" }, "additionalProperties": me }),
        ),
        (
            "required",
            json!({ "type": "array", "items": { "type": "string" } }),
        ),
        ("additionalProperties", json!({ "const": false })),
        ("maxLength", count(1, subset::LONGEST_STRING)),
        ("minLength", count(0, subset::LONGEST_STRING)),
        (
            "enum",
            json!({ "type": "array", "minItems": 1, "maxItems": subset::MOST_ENUM,
                    "items": { "type": "string", "maxLength": subset::ENUM_CHARS } }),
        ),
        ("minimum", json!({ "type": "number" })),
        ("maximum", json!({ "type": "number" })),
        ("items", me),
        ("maxItems", count(1, subset::MOST_ITEMS)),
        ("minItems", count(0, subset::MOST_ITEMS)),
    ];
    for (keyword, schema) in pairs {
        properties.insert(keyword.to_owned(), schema);
    }
    // Each kind takes only its own keywords.
    let every: Vec<&str> = subset::KINDS
        .iter()
        .flat_map(|(_, words)| words.iter().copied())
        .collect();
    let mut rules = vec![
        json!({ "anyOf": [{ "required": ["type"] }, { "required": ["enum"] }] }),
        json!({ "if": { "required": ["type"], "properties": { "type": { "const": "string" } } },
                "then": { "anyOf": [{ "required": ["maxLength"] }, { "required": ["enum"] }] } }),
        json!({ "if": { "required": ["type"], "properties": { "type": { "const": "array" } } },
                "then": { "required": ["maxItems", "items"] } }),
    ];
    for (kinds, own) in subset::KINDS {
        let kinds: Vec<&str> = kinds.split(", ").collect();
        let others: Map<String, Value> = every
            .iter()
            .filter(|word| !own.contains(word))
            .map(|word| ((*word).to_owned(), Value::Bool(false)))
            .collect();
        rules.push(
            json!({ "if": { "required": ["type"], "properties": { "type": { "enum": kinds } } },
                           "then": { "properties": others } }),
        );
    }
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties,
        "allOf": rules,
    })
}

/// What a card shows, as `card_show` takes it.
fn card() -> Value {
    let mut out = head("card.schema.json", "A card");
    let data = crate::card::schema()["properties"]["data"].clone();
    if let Value::Object(fields) = data {
        for (key, value) in fields {
            out.entry(key).or_insert(value);
        }
    }
    Value::Object(out)
}

/// A scenario test file, `tests/<name>.json`.
fn scenario_schema() -> Value {
    let mut out = head("scenario.schema.json", "A scenario test");
    let written =
        serde_json::to_value(schemars::schema_for!(scenario::Scenario)).unwrap_or_default();
    if let Value::Object(fields) = written {
        for (key, value) in fields {
            if key != "$schema" && key != "title" {
                out.insert(key, value);
            }
        }
    }
    Value::Object(out)
}
