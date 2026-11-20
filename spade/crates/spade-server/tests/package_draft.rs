//! `GET /v1/agents/{id}/package-draft` (ADR 0200 §9, `ace bot init --from`): one of the person's
//! bots as a version 3 package manifest. It carries the bot's task, personality and routines as
//! triggers, declares each effect its calls were read as (with a `why` still to write), and never
//! the conversation, a webhook secret or a model id. Someone else's package isn't the person's to
//! draft from.

mod support;

use serde_json::{Value, json};
use spade_core::effect::Effect;
use spade_core::event::{Event, Known};
use spade_core::tools::Risk;
use support::{Result, Spade};

async fn patch(spade: &Spade, id: &str, body: Value) -> Result<(u16, Value)> {
    let response = spade
        .http
        .patch(format!("{}/v1/agents/{id}", spade.base))
        .bearer_auth(support::TOKEN)
        .json(&body)
        .send()
        .await?;
    Ok((response.status().as_u16(), response.json().await?))
}

fn started(call: &str, name: &str, effect: Option<Effect>) -> Event {
    Event::Known(Known::ToolStarted {
        reply: "r1".to_owned(),
        call_id: call.to_owned(),
        name: name.to_owned(),
        risk: Some(Risk::Write),
        background: false,
        effect,
    })
}

async fn routine(spade: &Spade, bot: &str, body: Value) -> Result<Value> {
    let (status, made) = spade
        .post(&format!("/v1/agents/{bot}/routines"), body)
        .await?;
    assert_eq!(status, 201, "{made}");
    Ok(made)
}

#[tokio::test]
async fn a_bot_drafts_as_a_package_declaring_what_its_calls_did_and_nothing_of_the_person() -> Result
{
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let agent = spade
        .new_agent("Release notes", "You write release notes.")
        .await?;
    let bot = agent["id"].as_str().unwrap_or_default().to_owned();
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, body) = patch(
        &spade,
        &bot,
        json!({ "personality": { "tone": "warm", "humour": true, "emoji": false } }),
    )
    .await?;
    assert_eq!(status, 200, "{body}");
    routine(
        &spade,
        &bot,
        json!({ "name": "Friday notes", "instruction": "Write the week's notes.",
                "trigger": { "kind": "schedule", "schedule": "0 16 * * 5" } }),
    )
    .await?;
    routine(
        &spade,
        &bot,
        json!({ "name": "After a thread", "instruction": "Note what it changed.",
                "trigger": { "kind": "event", "event": "thread_done" } }),
    )
    .await?;
    let hook = routine(
        &spade,
        &bot,
        json!({ "name": "On a push", "instruction": "Read the push.",
                "trigger": { "kind": "webhook" } }),
    )
    .await?;
    let secret = hook["routine"]["webhook"]["secret"]
        .as_str()
        .unwrap_or("")
        .to_owned();

    // What happened in its conversation: the person's words, a read, a publish, a driving step,
    // and a command the classifier read as a send.
    let store = spade_store::Store::open(&spade.database())?;
    for event in [
        Event::from_json(json!({
            "type": "user_message", "text": "My sister Asha's birthday is on the ninth.",
        })),
        started("c1", "web_fetch", Some(Effect::Read)),
        started("c2", "npm_publish", Some(Effect::Publish)),
        started("c3", "browser_click", Some(Effect::Drive)),
        started("c4", "workspace_write", Some(Effect::WriteLocal)),
        Event::from_json(json!({
            "type": "call_reviewed", "reply": "r1", "call_id": "c5", "allowed": true,
            "model": "fake/m", "reason": "", "raised": "send_as_person",
        })),
    ] {
        store.append(&conversation, &event, 1)?;
    }

    let (status, drafted) = spade
        .get(&format!("/v1/agents/{bot}/package-draft"))
        .await?;
    assert_eq!(status, 200, "{drafted}");
    let draft = &drafted["recipe"];
    assert_eq!(draft["version"], 3);
    assert_eq!(draft["name"], "Release notes");
    assert_eq!(draft["task"], "You write release notes.");
    assert_eq!(
        draft["personality"],
        json!({ "tone": "warm", "humour": true, "emoji": false })
    );
    assert_eq!(
        draft["triggers"],
        json!([
            { "kind": "message" },
            { "kind": "schedule", "name": "Friday notes", "instruction": "Write the week's notes.",
              "schedule": "0 16 * * 5" },
            { "kind": "event", "name": "After a thread", "instruction": "Note what it changed.",
              "event": "thread.finished" },
            { "kind": "webhook", "name": "On a push", "instruction": "Read the push." },
        ])
    );
    let declared: Vec<&str> = draft["effects"]
        .as_array()
        .map(|all| all.iter().filter_map(|e| e["effect"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(
        declared,
        ["network", "publish", "send_as_person"],
        "a driving step needs network; reads and its own writes need nothing"
    );
    for effect in draft["effects"].as_array().into_iter().flatten() {
        assert!(
            effect["why"].as_str().unwrap_or("").starts_with("TODO"),
            "{effect}"
        );
    }

    let text = draft.to_string();
    for absent in ["Asha", "fake/m", &conversation] {
        assert!(!text.contains(absent), "the draft holds {absent:?}: {text}");
    }
    assert!(
        !secret.is_empty() && !text.contains(&secret),
        "the webhook secret stayed home"
    );

    // It reads as a version 3 package as written.
    spade_server::packages::manifest(draft).map_err(|e| e.to_string())?;
    Ok(())
}

#[tokio::test]
async fn a_bot_from_someone_elses_package_and_spade_itself_are_not_drafted() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({
                "recipe": { "format": "spade-bot", "version": 2, "name": "Inbox", "blurb": "",
                            "task": "You sort mail.", "model": "fast" },
                "from_recipe": { "source": "market", "name": "inbox", "version": "1.0.0" },
                "grants": { "connectors": [], "plugins": [], "skills": [] },
                "start_routines": false,
            }),
        )
        .await?;
    assert!(status < 300, "{made}");
    let bot = made["agent"]["id"].as_str().unwrap_or_default().to_owned();
    let (status, body) = spade
        .get(&format!("/v1/agents/{bot}/package-draft"))
        .await?;
    assert_eq!(status, 400, "{body}");
    assert!(body.to_string().contains("maker's package"), "{body}");

    let (_, listed) = spade.get("/v1/agents").await?;
    let main = listed["agents"]
        .as_array()
        .and_then(|all| all.iter().find(|a| a["kind"] == "main"))
        .and_then(|a| a["id"].as_str())
        .unwrap_or_default()
        .to_owned();
    let (status, body) = spade
        .get(&format!("/v1/agents/{main}/package-draft"))
        .await?;
    assert_eq!(status, 400, "{body}");
    Ok(())
}
