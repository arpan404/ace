//! Agent packages as the daemon sends them to Spade's API (ADR 0200 §3), for the package tests:
//! the flight watcher manifest at two versions, signed by a test market key, and readers for
//! what the API answers.

use std::sync::Arc;

use serde_json::{Value, json};
use spade_server::clock::{CountingIds, SystemClock};
use spade_server::security::{Security, Setup};
use spade_server::tools::{EngineHandle, Tool};
use spade_store::Store;
use spade_testkit::Script;

use super::market;
use super::{Result, Spade};

pub fn watcher(version: &str) -> Value {
    let mut triggers = vec![
        json!({ "kind": "message" }),
        json!({ "kind": "schedule", "name": "Morning check", "instruction": "Check every watched trip.", "schedule": "daily at 7:00" }),
        json!({ "kind": "event", "name": "After a failure", "instruction": "Look at what failed.", "event": "thread.failed" }),
        json!({ "kind": "webhook", "name": "Fare feed", "instruction": "Read the posted fare." }),
    ];
    let mut effects = vec![
        json!({ "effect": "network", "hosts": ["api.example-fares.com"], "why": "Reads fares." }),
        json!({ "effect": "send_as_person", "why": "Drafts a mail to your travel agent. You send it." }),
    ];
    let mut task = "You watch flight fares for the person.".to_owned();
    if version == "2.0.0" {
        triggers.push(json!({ "kind": "schedule", "name": "Evening check", "instruction": "Check again.", "schedule": "daily at 19:00" }));
        effects.push(json!({ "effect": "publish", "why": "Posts a weekly fare report." }));
        task = "You watch flight and hotel prices for the person.".to_owned();
    }
    json!({
        "format": "spade-bot",
        "version": 3,
        "requires": { "runtime": "1" },
        "name": "Flight watcher",
        "blurb": "Watches fares.",
        "task": task,
        "model": "capable",
        "triggers": triggers,
        "effects": effects,
        "limits": { "spend_alert": { "usd_per_day": 0.5 }, "workers_at_once": 2 },
        "notes": ["The person books. Never press a purchase button."],
        "pricing": { "kind": "free" },
        "style": { "accent": "#2F7BEA" }
    })
}

/// The market identity of flight-watcher at `version`, as its signed manifest gives it.
pub fn package(version: &str) -> Value {
    let signed = market::envelope("flight-watcher", version, &watcher(version));
    json!({
        "source": "market",
        "name": "flight-watcher",
        "version": version,
        "hash": signed["signed"]["body"]["hash"],
    })
}

/// flight-watcher at `version`, with the market's signature over its bytes.
pub fn sealed(version: &str) -> Value {
    market::envelope("flight-watcher", version, &watcher(version))
}

pub fn install(switches: Value, start_routines: bool) -> Value {
    json!({
        "recipe": watcher("1.0.0"),
        "from_recipe": { "source": "market", "name": "flight-watcher", "version": "1.0.0", "transaction": "install-1" },
        "package": package("1.0.0"),
        "envelope": sealed("1.0.0"),
        "grants": { "connectors": [], "plugins": [], "skills": [] },
        "switches": switches,
        "start_routines": start_routines,
    })
}

pub fn hosts_on() -> Value {
    json!({ "network:hosts:api.example-fares.com": true, "send_as_person": true })
}

pub async fn secure(spade: &Spade) -> Result {
    let bots = EngineHandle::default();
    bots.set(&spade.engine);
    let data = spade.dir.path().to_path_buf();
    let security = Security::start(Setup {
        runner: spade_sandbox::Runner::unavailable("no sandbox in this test"),
        store: Store::open(&spade.database())?,
        home: data.join("home"),
        spade_data: data.clone(),
        ace_data: None,
        workspaces: data.join("workspace"),
        log_dir: data.join("egress"),
        clock: Arc::new(SystemClock),
        ids: Arc::new(CountingIds::default()),
        bots,
        person_key: None,
    })
    .await;
    spade.engine.set_security(security);
    market::trust(&spade.engine);
    Ok(())
}

pub async fn secured(scripts: Vec<Script>, tools: Vec<Arc<dyn Tool>>) -> Result<Spade> {
    let spade = Spade::start(scripts, tools).await?;
    secure(&spade).await?;
    Ok(spade)
}

pub fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

pub async fn bots(spade: &Spade) -> Result<Vec<Value>> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a["kind"] == "bot")
        .collect())
}

/// The bot's routines by name: (name, paused, instruction).
pub async fn routines(spade: &Spade, bot: &str) -> Result<Vec<(String, bool, String)>> {
    let (_, body) = spade.get(&format!("/v1/agents/{bot}/routines")).await?;
    let mut all: Vec<(String, bool, String)> = body["routines"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|r| {
            (
                text(&r["name"]),
                r["paused"].as_bool().unwrap_or(false),
                text(&r["instruction"]),
            )
        })
        .collect();
    all.sort();
    Ok(all)
}

pub async fn notes(spade: &Spade, bot: &str) -> Result<Vec<String>> {
    let (_, body) = spade.get(&format!("/v1/agents/{bot}/notes")).await?;
    let mut all: Vec<String> = body["notes"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|n| text(&n["text"]))
        .collect();
    all.sort();
    Ok(all)
}

pub async fn installed(spade: &Spade, switches: Value, start: bool) -> Result<Value> {
    let (status, made) = spade.post("/v1/agents", install(switches, start)).await?;
    assert_eq!(status, 201, "{made}");
    Ok(made["agent"].clone())
}

pub fn switches_of(package: &Value) -> Vec<(String, bool)> {
    package["effects"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|e| (text(&e["key"]), e["on"].as_bool().unwrap_or(false)))
        .collect()
}

pub fn finished<'a>(events: &'a [Value], call: &str) -> Option<&'a Value> {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
}

pub async fn plan(spade: &Spade, bot: &str, version: &str) -> Result<Value> {
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/package/plan"),
            json!({ "recipe": watcher(version) }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["plan"].clone())
}

pub async fn move_to(spade: &Spade, bot: &str, version: &str, transaction: &str) -> Result<Value> {
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/package"),
            json!({ "recipe": watcher(version), "package": package(version), "envelope": sealed(version), "transaction": transaction }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["package"].clone())
}
