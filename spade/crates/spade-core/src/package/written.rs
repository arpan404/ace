//! A read manifest written back as the `bot.json` that reads the same (ADR 0204 §2): what a
//! replay installs when it runs a bot's kept cases on the version the bot runs, since Spade keeps
//! a linked bot's manifest as read, not the bytes it came in. [`read`](super::read) of what this
//! writes gives the same manifest. Pure.

use serde_json::{Map, Value, json};

use super::checks::{Kind, Target};
use super::manifest::{ACE_EVENTS, FORMAT, Manifest, PackageTrigger, RUNTIME};
use super::surfaces::Surface;

/// `manifest` as a version 3 `bot.json`.
pub fn written(manifest: &Manifest) -> Value {
    let mut out = Map::new();
    let mut put = |key: &str, value: Value| {
        out.insert(key.to_owned(), value);
    };
    put("format", json!(FORMAT));
    put("version", json!(3));
    put("spec", json!(manifest.spec));
    put("requires", json!({ "runtime": RUNTIME }));
    put("name", json!(manifest.name));
    put("blurb", json!(manifest.blurb));
    put("task", json!(manifest.task));
    if let Some(face) = &manifest.face {
        put("face", Value::Object(face.clone()));
    }
    if let Some(style) = &manifest.style {
        put("style", json!({ "accent": style.accent }));
    }
    if let Some(personality) = &manifest.personality {
        put(
            "personality",
            serde_json::to_value(personality).unwrap_or(Value::Null),
        );
    }
    put("model", json!(manifest.model));
    if let Some(uses) = &manifest.uses {
        put("uses", json!(uses));
    }
    put(
        "triggers",
        Value::Array(
            manifest
                .triggers
                .iter()
                .map(|t| trigger(t, manifest))
                .collect(),
        ),
    );
    put("skills", json!(manifest.skills));
    put("plugins", json!(manifest.plugins));
    let mut needs = Map::new();
    if let Some(tools) = &manifest.tools {
        needs.insert("tools".to_owned(), json!(tools));
    }
    let connectors: Vec<Value> = manifest
        .connectors
        .iter()
        .map(|c| {
            if c.starts_with("https://") {
                json!({ "url": c })
            } else {
                json!({ "id": c })
            }
        })
        .collect();
    if !connectors.is_empty() {
        needs.insert("connectors".to_owned(), Value::Array(connectors));
    }
    if !needs.is_empty() {
        put("needs", Value::Object(needs));
    }
    put(
        "effects",
        serde_json::to_value(&manifest.effects).unwrap_or(Value::Null),
    );
    if !manifest.contracts.is_empty() {
        put(
            "contracts",
            serde_json::to_value(&manifest.contracts).unwrap_or(Value::Null),
        );
    }
    let limits = &manifest.limits;
    let mut written_limits = Map::new();
    if let Some(usd) = limits.spend_alert_usd_per_day {
        written_limits.insert("spend_alert".to_owned(), json!({ "usd_per_day": usd }));
    }
    if let Some(n) = limits.workers_at_once {
        written_limits.insert("workers_at_once".to_owned(), json!(n));
    }
    if let Some(n) = limits.workspace_mb {
        written_limits.insert("workspace_mb".to_owned(), json!(n));
    }
    if !written_limits.is_empty() {
        put("limits", Value::Object(written_limits));
    }
    put("tests", json!(manifest.tests));
    put("notes", json!(manifest.notes));
    put("pricing", json!({ "kind": "free" }));
    if !manifest.surfaces.is_empty() {
        put(
            "surfaces",
            Value::Array(manifest.surfaces.iter().map(surface).collect()),
        );
    }
    if !manifest.code.is_empty() {
        put(
            "code",
            serde_json::to_value(&manifest.code).unwrap_or(Value::Null),
        );
    }
    if !manifest.checks.is_empty() {
        put(
            "checks",
            Value::Array(
                manifest
                    .checks
                    .iter()
                    .map(|check| {
                        let on: Vec<String> = check.on.iter().map(place).collect();
                        let mut written = json!({ "name": check.name, "on": on });
                        match &check.kind {
                            Kind::Schema { rule } => {
                                written["kind"] = json!("schema");
                                written["rule"] = rule.clone();
                            }
                            Kind::Criterion { text } => {
                                written["kind"] = json!("criterion");
                                written["text"] = json!(text);
                            }
                        }
                        written
                    })
                    .collect(),
            ),
        );
    }
    Value::Object(out)
}

fn place(target: &Target) -> String {
    match target {
        Target::Contract(name) => format!("contract:{name}"),
        Target::Card(id) => format!("card:{id}"),
        Target::Goal => "goal".to_owned(),
    }
}

fn trigger(trigger: &PackageTrigger, manifest: &Manifest) -> Value {
    let verify = |name: &str, mut value: Value| {
        if manifest.verifies(name) {
            value["verify"] = json!(true);
        }
        value
    };
    match trigger {
        PackageTrigger::Message => json!({ "kind": "message" }),
        PackageTrigger::Mention { places } => json!({ "kind": "mention", "in": places }),
        PackageTrigger::Schedule {
            name,
            instruction,
            schedule,
        } => verify(
            name,
            json!({ "kind": "schedule", "name": name, "instruction": instruction, "schedule": schedule }),
        ),
        PackageTrigger::Event {
            name,
            instruction,
            event,
        } => {
            let word = ACE_EVENTS
                .iter()
                .find(|(_, e)| e == event)
                .map_or("thread.finished", |(word, _)| word);
            verify(
                name,
                json!({ "kind": "event", "name": name, "instruction": instruction, "event": word }),
            )
        }
        PackageTrigger::Webhook { name, instruction } => verify(
            name,
            json!({ "kind": "webhook", "name": name, "instruction": instruction }),
        ),
    }
}

fn surface(surface: &Surface) -> Value {
    match surface {
        Surface::Card { id, file } => json!({ "id": id, "kind": "card", "file": file }),
        Surface::Panel(panel) => {
            let mut written = serde_json::to_value(panel).unwrap_or(Value::Null);
            if let Some(fields) = written.as_object_mut() {
                // Spade's own, set when the page arrived; never part of the manifest.
                fields.remove("hash");
                fields.insert("kind".to_owned(), json!("panel"));
            }
            written
        }
    }
}

#[cfg(test)]
#[path = "written_tests.rs"]
mod tests;
