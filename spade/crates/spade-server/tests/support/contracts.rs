//! A Trip planner calling a packaged Flight watcher's `cheapest_fare` (ADR 0200 §7), for the
//! contract tests: the package, the scripted steps that call and return, and readers.

use std::sync::Arc;

use serde_json::{Value, json};
use spade_server::tools::Tool;
use spade_testkit::{FakeProvider, Script};

use super::packaged::{secure, text};
use super::{Options, Result, Spade};

/// Flight watcher as a local package: it reaches its fare host and may publish, and its one
/// contract may use neither.
pub fn watcher() -> Value {
    json!({
        "format": "spade-bot",
        "version": 3,
        "requires": { "runtime": "1" },
        "name": "Flight watcher",
        "blurb": "Watches fares.",
        "task": "You watch flight fares for the person.",
        "effects": [
            { "effect": "network", "hosts": ["api.example-fares.com"], "why": "Reads fares." },
            { "effect": "publish", "why": "Posts a weekly fare report." }
        ],
        "contracts": [{
            "name": "cheapest_fare",
            "summary": "The cheapest fare seen for a route this week.",
            "input": {
                "type": "object",
                "properties": {
                    "from": { "type": "string", "minLength": 3, "maxLength": 3 },
                    "to": { "type": "string", "minLength": 3, "maxLength": 3 },
                    "month": { "type": "string", "maxLength": 7 }
                },
                "required": ["from", "to", "month"]
            },
            "output": {
                "type": "object",
                "properties": {
                    "fare": { "type": "number", "minimum": 0 },
                    "currency": { "type": "string", "maxLength": 3 }
                },
                "required": ["fare", "currency"]
            },
            "effects": []
        }],
        "pricing": { "kind": "free" }
    })
}

const INPUT: &str = r#"{"from": "KTM", "to": "DEL", "month": "2027-01"}"#;

pub fn input() -> Value {
    serde_json::from_str(INPUT).unwrap_or_default()
}

/// The planner's step that calls the contract.
pub fn calls(id: &str) -> Script {
    Script::reply("").call(
        id,
        "contract_call",
        json!({ "bot": "Flight watcher", "contract": "cheapest_fare", "input": input() }),
    )
}

/// The watcher's step that answers call `call` with `output`.
pub fn returns(id: &str, call: &str, output: Value) -> Script {
    Script::reply("").call(
        id,
        "contract_return",
        json!({ "call": call, "output": output }),
    )
}

/// The id the planner's job `job` calls with (`spade_server::engine::contracts::call_id`).
pub fn call_of(planner: &str, job: &str) -> String {
    format!("cc.{planner}.{job}")
}

pub async fn own_endpoint(spade: &Spade, name: &str, scripts: Vec<Script>) -> Result<FakeProvider> {
    let fake = FakeProvider::start_sequence(scripts).await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": name, "format": "openai-chat", "base_url": fake.root, "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok(fake)
}

pub fn of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == kind).collect()
}

/// The install body for `recipe` as the market signed it, its first contract's schemas moved
/// out of `bot.json` into `contracts/cheapest-fare.json`, both switches on. Install it on a Spade
/// that trusts the market's keys (`super::market::trust`).
pub fn from_schema_file(recipe: &Value) -> Value {
    let path = "contracts/cheapest-fare.json";
    let schemas = serde_json::to_string_pretty(&json!({
        "input": recipe["contracts"][0]["input"],
        "output": recipe["contracts"][0]["output"],
    }))
    .unwrap_or_default();
    let mut filed = recipe.clone();
    filed["contracts"][0] = json!({
        "name": recipe["contracts"][0]["name"],
        "summary": recipe["contracts"][0]["summary"],
        "file": path,
        "effects": recipe["contracts"][0]["effects"],
    });
    let envelope =
        super::market::envelope_with("flight-watcher", "1.0.0", &filed, &[(path, &schemas)]);
    json!({
        "envelope": envelope,
        "from_recipe": { "source": "market", "name": "flight-watcher", "version": "1.0.0", "transaction": "install-1" },
        "grants": { "connectors": [], "plugins": [], "skills": [] },
        "switches": { "network:hosts:api.example-fares.com": true, "publish": true },
    })
}

/// The install body for the watcher as a local package, both its switches on.
pub fn install() -> Value {
    json!({
        "recipe": watcher(),
        "from_recipe": { "source": "local", "name": "flight-watcher", "version": "dev" },
        "grants": { "connectors": [], "plugins": [], "skills": [] },
        "switches": { "network:hosts:api.example-fares.com": true, "publish": true },
    })
}

/// The two bots, each on a fake of its own, and titles on a third.
pub struct World {
    pub spade: Spade,
    pub planner: String,
    pub watcher_id: String,
    pub watcher: String,
    /// Titles, the planner's and the watcher's.
    pub fakes: Vec<FakeProvider>,
}

/// `watcher_scripts` is given the id of the planner's call `p1`, known once the planner exists.
pub async fn world(
    planner_scripts: Vec<Script>,
    watcher_scripts: impl FnOnce(&str) -> Vec<Script>,
    tools: Vec<Arc<dyn Tool>>,
) -> Result<World> {
    world_installing(install(), planner_scripts, watcher_scripts, tools).await
}

/// [`world`] with the watcher installed from `installed`; the market's keys are trusted when it
/// is a market envelope.
pub async fn world_installing(
    installed: Value,
    planner_scripts: Vec<Script>,
    watcher_scripts: impl FnOnce(&str) -> Vec<Script>,
    tools: Vec<Arc<dyn Tool>>,
) -> Result<World> {
    let spade = Spade::start_with(Vec::new(), tools, Options::default()).await?;
    if installed.get("envelope").is_some() {
        super::market::trust(&spade.engine);
    }
    secure(&spade).await?;
    let titles = own_endpoint(
        &spade,
        "Titles",
        vec![Script::reply("").plain(r#"{"title":"T"}"#); 8],
    )
    .await?;
    spade
        .put("/v1/settings", json!({ "fast_model": "titles/t" }))
        .await?;
    let planner_fake = own_endpoint(&spade, "Planner Net", planner_scripts).await?;
    let (status, planner) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Trip planner", "model": "planner-net/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{planner}");
    let planner = text(&planner["agent"]["conversation"]);
    let watcher_fake = own_endpoint(
        &spade,
        "Watcher Net",
        watcher_scripts(&call_of(&planner, "p1")),
    )
    .await?;
    let (status, made) = spade.post("/v1/agents", installed).await?;
    assert_eq!(status, 201, "{made}");
    let watcher_id = text(&made["agent"]["id"]);
    let (status, body) = spade
        .patch(
            &format!("/v1/agents/{watcher_id}"),
            json!({ "model": "watcher-net/m" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(World {
        planner,
        watcher: text(&made["agent"]["conversation"]),
        watcher_id,
        spade,
        fakes: vec![titles, planner_fake, watcher_fake],
    })
}
