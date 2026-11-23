//! Bots made on a coding subscription (`cli:…`, ADR 0133) before ADR 0219: after the upgrade
//! each thinks with the person's default model, keeps its conversation, and its chat says so once.

mod support;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::{Result, Spade};

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
