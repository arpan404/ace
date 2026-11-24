mod support;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_testkit::Script;
use support::{Result, TOKEN, person_stamp};

#[tokio::test]
async fn template_draft_refuses_personal_data_and_bearer_cannot_publish() -> Result {
    let proposal = json!({
        "description": "Measure rendering performance.",
        "task": "Record a baseline before making changes.",
        "notes": ["Compare results under the same conditions."],
        "knowledge": [
            {"kind":"playbook","topic":"renderer/performance","title":"Profile in stages","body":"Measure startup, parsing and rendering separately."},
            {"kind":"lesson","topic":"renderer/performance","title":"Warm caches change results","body":"Report cold and warm runs separately."}
        ],
        "heartbeat": {"every_minutes":60,"checklist":"Look for benchmark regressions."},
        "routines":[{"name":"Daily check","instruction":"Compare benchmark medians.","schedule":"daily at 09:00"}],
        "surfaces":[{
            "definition":{"kind":"panel","id":"results","file":"panels/results/index.html","title":"Benchmark totals"},
            "text":"<!doctype html><title>Benchmark totals</title><h1>Results</h1>"
        }],
        "contracts":[{
            "name":"summarize","summary":"Summarize a measured baseline.",
            "input":{"type":"object","properties":{"baseline":{"type":"number"}}},
            "output":{"type":"object","properties":{"summary":{"type":"string","maxLength":300}}}
        }],
    });
    let mut private = proposal.clone();
    private["knowledge"][1]["body"] = json!("Email the result to testing@example.test.");
    let mut copied = proposal.clone();
    copied["knowledge"][0]["body"] =
        json!("Open the archived results from my private benchmark run.");
    let spade = support::packaged::secured(
        vec![
            Script::reply("").call("private", "template_draft", private),
            Script::reply("").call("copied", "template_draft", copied),
            Script::reply("").call("clean", "template_draft", proposal),
            Script::reply("The template is unpublished."),
        ],
        Vec::new(),
    )
    .await?;
    let agent = spade
        .new_agent("Render benchmarks", "Work in /Users/test/private.")
        .await?;
    let chat = agent["conversation"].as_str().unwrap_or_default();
    let bot = agent["id"].as_str().ok_or("missing source bot")?;
    let (status, _) = spade.post(&format!("/v1/agents/{bot}/knowledge"), json!({
        "topic":"rendering","title":"Archived run","body":"Open the archived results from my private benchmark run."
    })).await?;
    assert_eq!(status, 201);
    spade.say(chat, "Draft a template.").await?;
    let events = spade.wait_for(chat, "reply_finished").await?;
    let cards: Vec<&Value> = events
        .iter()
        .filter(|event| event["type"] == "card_shown")
        .collect();
    assert_eq!(cards.len(), 1, "{events:?}");
    let id = cards[0]["card"].as_str().unwrap_or_default();
    let (status, details) = spade.get(&format!("/v1/share-templates/{id}")).await?;
    assert_eq!(status, 200);
    assert_eq!(details["visibility"], Value::Null);
    assert_eq!(details["draft"]["recipe"]["version"], 3);
    assert!(!details["draft"]["recipe"].to_string().contains("fake/m"));
    assert_eq!(
        details["draft"]["recipe"]["model_roles"]["helper"],
        "capable"
    );
    assert_eq!(
        details["draft"]["recipe"]["task"],
        "Record a baseline before making changes."
    );
    assert_eq!(
        details["draft"]["recipe"]["notes"],
        json!(["Compare results under the same conditions."])
    );
    assert_eq!(
        details["draft"]["recipe"]["knowledge"][0]["kind"],
        "playbook"
    );
    assert_eq!(details["draft"]["recipe"]["knowledge"][1]["kind"], "lesson");
    assert_eq!(details["draft"]["recipe"]["heartbeat"]["every_minutes"], 60);
    assert_eq!(
        details["draft"]["surface_files"][0]["path"],
        "panels/results/index.html"
    );
    assert_eq!(
        details["draft"]["recipe"]["contracts"][0]["name"],
        "summarize"
    );

    let path = format!("/v1/share-templates/{id}/authorize");
    let review = json!({
        "revision": details["revision"],
        "visibility": "unlisted",
        "name": "Render benchmarks",
        "description": "Measure rendering performance.",
        "task": "Compare median run times.",
        "notes": [],
        "skills": [],
        "routines": [],
        "connectors": [],
        "knowledge": [details["draft"]["recipe"]["knowledge"][1].clone()],
        "surfaces": [],
        "include_heartbeat": true,
    });
    let (status, _) = spade.post_unstamped(&path, review.clone()).await?;
    assert_eq!(status, 403);

    let bytes = serde_json::to_vec(&review)?;
    let hash: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let stamp = person_stamp(
        &spade.person_key_path,
        &format!("template:{id}"),
        &format!("authorize:{hash}"),
    )?;
    let response = spade
        .http
        .post(format!("{}{path}", spade.base))
        .bearer_auth(TOKEN)
        .header(spade_server::security::attest::HEADER, &stamp)
        .body(bytes.clone())
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 200);
    let authorized: Value = response.json().await?;
    assert_eq!(authorized["recipe"]["task"], "Compare median run times.");
    assert_eq!(authorized["recipe"]["notes"], json!([]));
    assert_eq!(
        authorized["recipe"]["knowledge"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(authorized["recipe"]["knowledge"][0]["kind"], "lesson");
    assert_eq!(authorized["surface_files"], json!([]));

    let replay = spade
        .http
        .post(format!("{}{path}", spade.base))
        .bearer_auth(TOKEN)
        .header(spade_server::security::attest::HEADER, stamp)
        .body(bytes)
        .send()
        .await?;
    assert_eq!(replay.status().as_u16(), 403);

    let (_, still) = spade.get(&format!("/v1/share-templates/{id}")).await?;
    assert_ne!(still["revision"], details["revision"]);
    assert_eq!(still["visibility"], Value::Null);
    assert_eq!(still["draft"], authorized);
    let (status, installed) = spade
        .post(
            "/v1/agents",
            json!({
                "recipe": authorized["recipe"],
                "from_recipe": {"source":"local","name":"benchmark-template","version":"1.0.0"},
                "start_routines": false,
            }),
        )
        .await?;
    assert_eq!(status, 201, "{installed}");
    let bot = installed["agent"]["id"]
        .as_str()
        .ok_or("missing installed bot")?;
    let (status, knowledge) = spade.get(&format!("/v1/agents/{bot}/knowledge")).await?;
    assert_eq!(status, 200);
    assert_eq!(
        knowledge["entries"][0]["title"],
        "Warm caches change results"
    );
    assert_eq!(
        knowledge["entries"][0]["body"],
        "Report cold and warm runs separately."
    );
    let (status, heartbeat) = spade.get(&format!("/v1/agents/{bot}/heartbeat")).await?;
    assert_eq!(status, 200);
    assert_eq!(heartbeat["heartbeat"]["enabled"], false);
    assert_eq!(heartbeat["heartbeat"]["every_minutes"], 60);
    Ok(())
}
