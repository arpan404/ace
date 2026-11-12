//! Bots from templates, duplicated, exported and imported (ADR 0132).

mod support;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::{Options, Result, Spade};

fn id(agent: &Value) -> String {
    agent["id"].as_str().unwrap_or_default().to_owned()
}

async fn routines(spade: &Spade, agent: &str) -> Result<Vec<(String, Value, bool)>> {
    let (_, body) = spade.get(&format!("/v1/agents/{agent}/routines")).await?;
    Ok(body["routines"]
        .as_array()
        .map(|all| {
            all.iter()
                .map(|r| {
                    (
                        r["name"].as_str().unwrap_or("").to_owned(),
                        r["trigger"].clone(),
                        r["paused"].as_bool().unwrap_or(false),
                    )
                })
                .collect()
        })
        .unwrap_or_default())
}

async fn notes(spade: &Spade, agent: &str) -> Result<Vec<String>> {
    let (_, body) = spade.get(&format!("/v1/agents/{agent}/notes")).await?;
    Ok(body["notes"]
        .as_array()
        .map(|n| {
            n.iter()
                .filter_map(|n| n["text"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default())
}

/// A bot with a task, a coloured face, a paused routine, a webhook, a note and all connectors.
async fn furnished(spade: &Spade) -> Result<Value> {
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Research", "task": "Find sources.", "model": "fake/m",
                    "avatar": { "kind": "generated", "color": "teal" } }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let agent = made["agent"].clone();
    let bot = id(&agent);
    for body in [
        json!({ "name": "Digest", "instruction": "Send the digest.",
                "trigger": { "kind": "schedule", "schedule": "daily at 9:00" },
                "time_zone": "UTC", "paused": true }),
        json!({ "name": "Hook", "instruction": "Run on a hook.",
                "trigger": { "kind": "webhook" } }),
    ] {
        let (status, body) = spade
            .post(&format!("/v1/agents/{bot}/routines"), body)
            .await?;
        assert_eq!(status, 201, "{body}");
    }
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/notes"),
            json!({ "text": "Prefers recent papers" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{bot}/connectors"),
            json!({ "all": true }),
        )
        .await?;
    assert!(status < 300, "{body}");
    Ok(agent)
}

fn with_connectors() -> Options {
    Options {
        connectors: true,
        ..Options::default()
    }
}

#[tokio::test]
async fn a_template_makes_a_bot_with_its_task_face_and_routines() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let (_, listed) = spade.get("/v1/templates").await?;
    let templates = listed["templates"].as_array().cloned().unwrap_or_default();
    assert!(templates.len() >= 8);
    let inbox = templates
        .iter()
        .find(|t| t["id"] == "inbox")
        .cloned()
        .unwrap_or_default();

    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({ "template": "inbox", "model": "fake/m", "time_zone": "Europe/Berlin" }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let agent = &made["agent"];
    assert_eq!(agent["name"], "Inbox");
    assert_eq!(agent["task"], inbox["task"]);
    assert_eq!(agent["avatar"]["color"], inbox["color"]);
    let made_routines = routines(&spade, &id(agent)).await?;
    assert_eq!(
        made_routines.len(),
        inbox["routines"].as_array().map_or(0, Vec::len)
    );
    assert_eq!(
        made_routines[0].0,
        inbox["routines"][0]["name"].as_str().unwrap_or("")
    );

    let (status, _) = spade
        .post("/v1/agents", json!({ "template": "no-such-role" }))
        .await?;
    assert_eq!(status, 404);
    Ok(())
}

#[tokio::test]
async fn duplicate_copies_the_bot_but_not_its_conversation() -> Result {
    let spade =
        Spade::start_with(vec![Script::reply("Noted.")], Vec::new(), with_connectors()).await?;
    let original = furnished(&spade).await?;
    let conversation = original["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Remember this chat").await?;
    spade.wait_for(&conversation, "reply_finished").await?;

    let (status, made) = spade
        .post(
            &format!("/v1/agents/{}/duplicate", id(&original)),
            json!({}),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let copy = &made["agent"];
    assert_ne!(copy["id"], original["id"]);
    assert_eq!(copy["name"], "Research copy");
    assert_eq!(copy["task"], "Find sources.");
    assert_eq!(copy["model"], original["model"]);
    assert_eq!(copy["avatar"]["color"], "teal");
    assert_eq!(
        routines(&spade, &id(copy)).await?,
        routines(&spade, &id(&original)).await?,
        "same routines, the paused one still paused"
    );
    assert_eq!(
        notes(&spade, &id(copy)).await?,
        vec!["Prefers recent papers"]
    );
    let (_, access) = spade
        .get(&format!("/v1/agents/{}/connectors", id(copy)))
        .await?;
    assert_eq!(access["all"], true, "connector choices come along");
    let theirs = spade
        .events(copy["conversation"].as_str().unwrap_or_default())
        .await?;
    assert!(
        !theirs.iter().any(|e| e["type"] == "user_message"),
        "the conversation stays with the original"
    );
    Ok(())
}

#[tokio::test]
async fn an_export_holds_no_secrets_and_importing_it_elsewhere_recreates_the_bot() -> Result {
    let home =
        Spade::start_with(vec![Script::reply("unused")], Vec::new(), with_connectors()).await?;
    let original = furnished(&home).await?;
    let (_, before) = home
        .get(&format!("/v1/agents/{}/routines", id(&original)))
        .await?;
    let secret = before["routines"].as_array().and_then(|all| {
        all.iter()
            .find_map(|r| r["secret"].as_str().map(str::to_owned))
    });

    let (status, file) = home
        .get(&format!("/v1/agents/{}/export", id(&original)))
        .await?;
    assert_eq!(status, 200, "{file}");
    assert_eq!(file["format"], "spade-bot");
    let text = file.to_string();
    for absent in ["secret", "conversation", "Remember", "token"] {
        assert!(!text.contains(absent), "the file holds {absent:?}: {text}");
    }
    if let Some(secret) = secret {
        assert!(!text.contains(&secret), "the webhook secret stayed home");
    }

    // Another machine: another Spade, without connectors.
    let away = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let (status, made) = away.post("/v1/agents/import", file).await?;
    assert_eq!(status, 201, "{made}");
    let agent = &made["agent"];
    assert_eq!(agent["name"], "Research");
    assert_eq!(agent["task"], "Find sources.");
    assert_eq!(agent["avatar"]["color"], "teal");
    assert_eq!(
        routines(&away, &id(agent)).await?,
        routines(&home, &id(&original)).await?
    );
    assert_eq!(
        notes(&away, &id(agent)).await?,
        vec!["Prefers recent papers"]
    );
    let left_out: Vec<String> = made["left_out"]
        .as_array()
        .map(|l| {
            l.iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(left_out, vec!["Connectors aren't set up on this machine."]);

    let (status, _) = away
        .post(
            "/v1/agents/import",
            json!({ "format": "something-else", "version": 1, "name": "X" }),
        )
        .await?;
    assert_eq!(status, 400);
    Ok(())
}
