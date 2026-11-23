//! Bots made on a coding subscription (`cli:…`, ADR 0133) before ADR 0219: after the upgrade
//! each thinks with the person's default model, keeps its conversation, and its chat says so once.

mod support;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::{Options, Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"A title"}"#)
}

async fn agent(spade: &Spade, id: &str) -> Result<Value> {
    let (status, body) = spade.get("/v1/agents").await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["agents"]
        .as_array()
        .and_then(|all| all.iter().find(|a| a["id"] == id))
        .cloned()
        .unwrap_or_default())
}

#[tokio::test]
async fn a_bot_on_a_subscription_moves_to_the_default_model_and_keeps_its_conversation() -> Result {
    let spade = Spade::start(vec![Script::reply("Sure."), title()], Vec::new()).await?;
    let made = spade.new_agent("Trips", "Plan trips.").await?;
    let id = made["id"].as_str().unwrap_or_default().to_owned();
    let conversation = made["conversation"].as_str().unwrap_or_default().to_owned();
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;

    // What an older build left: the bot on a subscription.
    let spade = spade
        .restart_after_crash(
            &format!("UPDATE agents SET model = 'cli:codex@work/gpt-6.1-sol' WHERE id = '{id}';"),
            Vec::new(),
            vec![Script::reply("Still here.")],
        )
        .await?;
    let events = spade.wait_for(&conversation, "model_replaced").await?;
    let replaced: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "model_replaced")
        .collect();
    assert_eq!(replaced.len(), 1, "one line: {events:?}");
    assert_eq!(replaced[0]["from"], "cli:codex@work/gpt-6.1-sol");
    assert_eq!(replaced[0]["to"], "fake/m");
    let line = replaced[0]["line"].as_str().unwrap_or_default();
    assert!(line.contains("moved from its Codex model to"), "{line}");
    assert_eq!(agent(&spade, &id).await?["model"], "fake/m");
    // Its conversation is kept, and it answers on the model it moved to.
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "user_message" && e["text"] == "Hi"),
        "{events:?}"
    );
    spade.say(&conversation, "Again").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    assert_eq!(spade.fake.seen()[0].body["model"], "m");

    // A later start finds nothing to move.
    let spade = spade.restart(Vec::new(), Vec::new()).await?;
    assert_eq!(agent(&spade, &id).await?["model"], "fake/m");
    let events = spade.events(&conversation).await?;
    assert_eq!(
        events
            .iter()
            .filter(|e| e["type"] == "model_replaced")
            .count(),
        1
    );
    Ok(())
}

/// A keyless endpoint on the fake with one model that calls tools; its id.
async fn endpoint(spade: &Spade, name: &str, model: &str) -> Result<String> {
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": name, "format": "openai-chat", "base_url": &spade.fake.root,
                    "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let id = body["endpoint"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, body) = spade
        .post(
            &format!("/v1/endpoints/{id}/models"),
            json!({ "id": model, "capabilities": ["tools"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    Ok(id)
}

/// Marks `model` on endpoint `id` as one that can't call tools.
async fn without_tools(spade: &Spade, id: &str, model: &str) -> Result {
    let (status, body) = spade
        .post(
            &format!("/v1/endpoints/{id}/models"),
            json!({ "id": model, "capabilities": [] }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(())
}

/// The bot `made` an older build left on `model`: the SQL that puts it there.
fn on_subscription(made: &Value, model: &str) -> String {
    let id = made["id"].as_str().unwrap_or_default();
    format!("UPDATE agents SET model = '{model}' WHERE id = '{id}';")
}

#[tokio::test]
async fn a_bot_is_never_moved_to_a_model_that_cant_run_it() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let made = spade.new_agent("Trips", "").await?;
    let conversation = made["conversation"].as_str().unwrap_or_default().to_owned();
    // The person's main route leads with a model that turned out not to call tools.
    let tiny = endpoint(&spade, "Tiny", "small").await?;
    let (status, body) = spade
        .put(
            "/v1/models/roles",
            json!({ "roles": { "main": [format!("{tiny}/small")] } }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    without_tools(&spade, &tiny, "small").await?;
    let spade = spade
        .restart_after_crash(
            &on_subscription(&made, "cli:codex/gpt-6.1-sol"),
            Vec::new(),
            vec![Script::reply("Here.")],
        )
        .await?;
    let events = spade.wait_for(&conversation, "model_replaced").await?;
    let replaced = events
        .iter()
        .find(|e| e["type"] == "model_replaced")
        .cloned()
        .unwrap_or_default();
    assert_eq!(replaced["to"], "fake/m", "{replaced}");
    let id = made["id"].as_str().unwrap_or_default();
    assert_eq!(agent(&spade, id).await?["model"], "fake/m");
    Ok(())
}

#[tokio::test]
async fn with_no_route_a_bot_moves_to_the_persons_model_for_new_bots() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let made = spade.new_agent("Trips", "").await?;
    let conversation = made["conversation"].as_str().unwrap_or_default().to_owned();
    let backup = endpoint(&spade, "Backup", "b").await?;
    let chosen = format!("{backup}/b");
    let (status, body) = spade
        .put("/v1/settings", json!({ "new_bot_model": chosen }))
        .await?;
    assert!(status < 300, "{body}");
    let spade = spade
        .restart_after_crash(
            &on_subscription(&made, "cli:codex/gpt-6.1-sol"),
            Vec::new(),
            Vec::new(),
        )
        .await?;
    let events = spade.wait_for(&conversation, "model_replaced").await?;
    let replaced = events
        .iter()
        .find(|e| e["type"] == "model_replaced")
        .cloned()
        .unwrap_or_default();
    assert_eq!(replaced["to"], chosen, "{replaced}");
    Ok(())
}

#[tokio::test]
async fn with_no_model_that_can_run_it_the_bot_waits_for_the_person() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let made = spade.new_agent("Trips", "").await?;
    let conversation = made["conversation"].as_str().unwrap_or_default().to_owned();
    let (_, models) = spade.get("/v1/models").await?;
    for endpoint in models["endpoints"].as_array().cloned().unwrap_or_default() {
        for model in endpoint["models"].as_array().cloned().unwrap_or_default() {
            without_tools(
                &spade,
                endpoint["id"].as_str().unwrap_or_default(),
                model["id"].as_str().unwrap_or_default(),
            )
            .await?;
        }
    }
    let spade = spade
        .restart_after_crash(
            &on_subscription(&made, "cli:claude/opus"),
            Vec::new(),
            Vec::new(),
        )
        .await?;
    let events = spade.wait_for(&conversation, "model_replaced").await?;
    let replaced = events
        .iter()
        .find(|e| e["type"] == "model_replaced")
        .cloned()
        .unwrap_or_default();
    assert_eq!(replaced["to"], "", "{replaced}");
    let line = replaced["line"].as_str().unwrap_or_default();
    assert!(
        line.contains("Claude Code model was removed. Pick a model"),
        "{line}"
    );
    let id = made["id"].as_str().unwrap_or_default();
    assert_eq!(agent(&spade, id).await?["model"], "");
    // It waits for the person: nothing is asked of any model.
    let _ = spade
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Hello?" }),
        )
        .await?;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(
        spade.fake.seen().is_empty(),
        "{:?}",
        spade.fake.seen().len()
    );
    Ok(())
}

#[tokio::test]
async fn a_reply_left_open_on_a_subscription_carries_on_with_the_new_model() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let made = spade.new_agent("Trips", "").await?;
    let conversation = made["conversation"].as_str().unwrap_or_default().to_owned();
    let stored = |body: Value| {
        format!(
            "INSERT INTO events (conversation_id, seq, at_ms, body) SELECT '{conversation}', \
             COALESCE(MAX(seq), 0) + 1, 0, '{body}' FROM events \
             WHERE conversation_id = '{conversation}';"
        )
    };
    // What an older build left when it paused mid-turn: a message, and its reply opened on a
    // subscription.
    let sql = [
        on_subscription(&made, "cli:codex/gpt-6.1-sol"),
        stored(json!({ "type": "user_message", "text": "Plan Lisbon" })),
        stored(
            json!({ "type": "reply_started", "reply": "r-old", "model": "cli:codex/gpt-6.1-sol" }),
        ),
        stored(json!({ "type": "turn_paused", "reply": "r-old" })),
    ]
    .join("\n");
    let spade = spade
        .restart_paused_with(
            &sql,
            Vec::new(),
            vec![Script::reply("On it.")],
            Options::default(),
        )
        .await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "reply_finished" && e["reply"] == "r-old"),
        "{events:?}"
    );
    assert_eq!(spade.fake.seen()[0].body["model"], "m");
    Ok(())
}

#[tokio::test]
async fn a_subscription_is_no_model_for_a_new_or_changed_bot() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Notes", "task": "", "model": "cli:codex/gpt-6.1-sol" }),
        )
        .await?;
    assert_eq!(status, 400, "{body}");
    let made = spade.new_agent("Notes", "").await?;
    let id = made["id"].as_str().unwrap_or_default();
    let (status, body) = spade
        .patch(
            &format!("/v1/agents/{id}"),
            json!({ "model": "cli:claude/opus" }),
        )
        .await?;
    assert_eq!(status, 400, "{body}");
    assert_eq!(agent(&spade, id).await?["model"], "fake/m");
    Ok(())
}
