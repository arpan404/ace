//! A Trip planner calling a packaged Flight watcher's `cheapest_fare` (ADR 0200 §7), for the
//! contract tests: the package, the scripted steps that call and return, and readers.

use serde_json::{Value, json};
use spade_testkit::{FakeProvider, Script};

use super::{Result, Spade};

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

/// The install body for the watcher as a local package, both its switches on.
pub fn install() -> Value {
    json!({
        "recipe": watcher(),
        "from_recipe": { "source": "local", "name": "flight-watcher", "version": "dev" },
        "grants": { "connectors": [], "plugins": [], "skills": [] },
        "switches": { "network:hosts:api.example-fares.com": true, "publish": true },
    })
}
