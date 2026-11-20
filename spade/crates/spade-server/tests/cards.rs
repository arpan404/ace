//! Cards (ADR 0200 §5.1): a bot's `card_show` through the real engine and API on a scripted fake
//! endpoint. A card that doesn't fit goes back to the bot with its problems; one that fits is
//! stored as its own row, and a choice the person presses reaches the bot once.

mod support;

use serde_json::{Value, json};
use spade_testkit::{Script, Seen};
use support::{Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Fares"}"#)
}

/// The model calls (streamed), leaving out titles.
fn turns(seen: &[Seen]) -> Vec<Value> {
    seen.iter()
        .filter(|s| s.body["stream"] == true)
        .map(|s| s.body.clone())
        .collect()
}

/// What the model was last sent, as one text.
fn last_sent(spade: &Spade) -> String {
    turns(&spade.fake.seen())
        .last()
        .map(|body| body["messages"].to_string())
        .unwrap_or_default()
}

fn fare_card() -> Value {
    json!({ "data": {
        "title": "Fare dropped: KTM to DEL",
        "blocks": [
            { "kind": "metric", "label": "Fare", "value": "182", "unit": "USD", "change": "-24" },
            { "kind": "actions", "actions": [
                { "kind": "choose", "id": "keep", "label": "Keep watching" },
                { "kind": "choose", "id": "stop", "label": "Stop watching" } ] } ] } })
}

fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

#[tokio::test]
async fn a_card_that_fits_is_shown_and_a_choice_on_it_reaches_the_bot_once() -> Result {
    let spade = Spade::start(
        vec![
            // First a card with a block ace doesn't draw: refused with its problems.
            Script::reply("").call(
                "s1",
                "card_show",
                json!({ "data": { "title": "Fare", "blocks": [{ "kind": "html", "body": "<b>" }] } }),
            ),
            Script::reply("").call("s2", "card_show", fare_card()),
            Script::reply("The fare dropped."),
            title(),
            Script::reply("I'll keep watching."),
        ],
        Vec::new(),
    )
    .await?;
    let made = spade.new_agent("Flight watcher", "Watch fares.").await?;
    let chat = made["conversation"].as_str().unwrap_or_default().to_owned();
    spade.say(&chat, "Watch KTM to DEL").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;

    // The refusal named the problem at its place, and nothing was shown for it.
    let refused = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "s1")
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(refused["is_error"], true);
    assert!(
        refused["content"]
            .as_str()
            .unwrap_or_default()
            .contains("data.blocks[0].kind: html is not a block"),
        "{refused}"
    );
    assert_eq!(count(&events, "card_shown"), 1);
    let shown = events
        .iter()
        .find(|e| e["type"] == "card_shown")
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(shown["call_id"], "s2");
    assert_eq!(shown["version"], 1);
    assert_eq!(shown["data"]["blocks"][0]["value"], "182");
    let card = shown["card"].as_str().unwrap_or_default().to_owned();
    assert!(!card.is_empty());

    // A choice the card doesn't have, or on a version the person never saw, is refused.
    let path = format!("/v1/conversations/{chat}/cards/{card}/actions");
    let (status, _) = spade
        .post(&path, json!({ "action": "book", "version": 1 }))
        .await?;
    assert_eq!(status, 409);
    let (status, _) = spade
        .post(&path, json!({ "action": "keep", "version": 2 }))
        .await?;
    assert_eq!(status, 409);

    let (status, _) = spade
        .post(&path, json!({ "action": "keep", "version": 1 }))
        .await?;
    assert_eq!(status, 202);
    let events = spade.wait_for_count(&chat, "reply_finished", 2).await?;
    assert!(
        last_sent(&spade).contains(
            "The person chose \\\"Keep watching\\\" on your card \\\"Fare dropped: KTM to DEL\\\""
        ),
        "{}",
        last_sent(&spade)
    );

    // Pressed again, or the other choice after it: nothing more reaches the bot.
    let model_calls = turns(&spade.fake.seen()).len();
    for action in ["keep", "stop"] {
        let (status, body) = spade
            .post(&path, json!({ "action": action, "version": 1 }))
            .await?;
        assert_eq!(status, 409, "{body}");
    }
    let events_after = spade.events(&chat).await?;
    assert_eq!(count(&events_after, "card_action"), 1);
    assert_eq!(
        count(&events_after, "reply_started"),
        count(&events, "reply_started")
    );
    assert_eq!(turns(&spade.fake.seen()).len(), model_calls);
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{chat}/cards/card_none/actions"),
            json!({ "action": "keep", "version": 1 }),
        )
        .await?;
    assert_eq!(status, 404);
    Ok(())
}
