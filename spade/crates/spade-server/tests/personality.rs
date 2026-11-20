//! A bot's personality: how it talks, set in its profile or brought by a template or recipe,
//! reaches its standing instructions as a section of its own, from the next turn on, and a task
//! change keeps it.

mod support;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::{Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"A title"}"#)
}

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

/// The standing instructions of the `n`th model call.
fn top(spade: &Spade, n: usize) -> String {
    spade
        .fake
        .seen()
        .get(n)
        .map(|seen| seen.body["messages"][0].to_string())
        .unwrap_or_default()
}

#[tokio::test]
async fn a_personality_set_in_the_profile_talks_from_the_next_turn_and_outlives_a_task_change()
-> Result {
    let spade = Spade::start(
        vec![
            Script::reply("Sure."),
            title(),
            Script::reply("Certainly."),
            Script::reply("Noted."),
        ],
        Vec::new(),
    )
    .await?;
    let agent = spade.new_agent("Trips", "Plan trips.").await?;
    let id = agent["id"].as_str().unwrap_or_default().to_owned();
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;
    assert!(!top(&spade, 0).contains("<personality>"), "none until set");

    let (status, changed) = patch(
        &spade,
        &id,
        json!({ "personality": { "tone": "formal", "humour": false, "emoji": false } }),
    )
    .await?;
    assert_eq!(status, 200, "{changed}");
    assert_eq!(changed["agent"]["personality"]["tone"], "formal");
    spade.say(&conversation, "Book it").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    let second = top(&spade, 2);
    let task_at = second.find("Plan trips.").unwrap_or(usize::MAX);
    let voice_at = second.find("<personality>").unwrap_or(0);
    assert!(
        voice_at > task_at,
        "its own section after the task: {second}"
    );
    assert!(second.contains("formal and precise") && second.contains("Don't use emoji"));

    // A new task keeps how it talks.
    let (status, _) = patch(&spade, &id, json!({ "task": "Track parcels." })).await?;
    assert_eq!(status, 200);
    spade.say(&conversation, "Where is it?").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 3)
        .await?;
    let third = top(&spade, 3);
    assert!(third.contains("Track parcels.") && third.contains("formal and precise"));

    // Cleared, it's left to the bot again.
    let (status, cleared) = patch(&spade, &id, json!({ "personality": null })).await?;
    assert_eq!(status, 200);
    assert_eq!(cleared["agent"]["personality"], Value::Null);
    let (status, _) = patch(
        &spade,
        &id,
        json!({ "personality": { "tone": "sarcastic" } }),
    )
    .await?;
    assert_eq!(status, 422, "a tone Spade doesn't know is refused");
    Ok(())
}

#[tokio::test]
async fn a_bot_made_from_a_template_talks_the_way_the_template_says() -> Result {
    let spade = Spade::start(vec![Script::reply("Here is what I found.")], Vec::new()).await?;
    let (status, made) = spade
        .post("/v1/agents", json!({ "template": "research" }))
        .await?;
    assert_eq!(status, 201, "{made}");
    assert_eq!(made["agent"]["personality"]["tone"], "formal");
    let conversation = made["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade
        .say(&conversation, "What changed in the tax rules?")
        .await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    assert!(top(&spade, 0).contains("formal and precise"));
    Ok(())
}
