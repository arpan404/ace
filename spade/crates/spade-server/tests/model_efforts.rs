//! How hard each role's model thinks (ADR 0213), through the real API with a scripted model:
//! every call carries its role's effort, the bot's choice beats the person's, which beats the
//! default, and an endpoint that refuses the setting still answers.

mod support;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::{Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Logs"}"#)
}

/// A bot on `fake/m`: its id and conversation.
async fn bot(spade: &Spade) -> Result<(String, String)> {
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Logs", "task": "", "model": "fake/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let agent = &body["agent"];
    let field = |name: &str| agent[name].as_str().unwrap_or_default().to_owned();
    Ok((field("id"), field("conversation")))
}

/// The bodies the endpoint was sent, streamed (a turn's step) or plain (a title).
fn sent(spade: &Spade, streamed: bool) -> Vec<Value> {
    spade
        .fake
        .seen()
        .into_iter()
        .map(|seen| seen.body)
        .filter(|body| body["stream"].as_bool().unwrap_or(false) == streamed)
        .collect()
}

fn role(view: &Value, name: &str) -> Value {
    view["roles"]
        .as_array()
        .and_then(|roles| roles.iter().find(|r| r["role"] == name).cloned())
        .unwrap_or_default()
}

#[tokio::test]
async fn a_bots_turns_think_at_medium_and_its_title_at_low_until_the_person_changes_them() -> Result
{
    let spade = Spade::start(
        vec![Script::reply("Hello."), title(), Script::reply("Again.")],
        Vec::new(),
    )
    .await?;
    let (agent, conversation) = bot(&spade).await?;
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;
    assert_eq!(sent(&spade, true)[0]["reasoning_effort"], "medium");
    assert_eq!(sent(&spade, false)[0]["reasoning_effort"], "low");

    let (status, global) = spade
        .put(
            "/v1/models/roles",
            json!({ "efforts": { "main": "low", "title": "off" } }),
        )
        .await?;
    assert_eq!(status, 200, "{global}");
    assert_eq!(global["efforts"]["main"], "low");
    assert_eq!(global["efforts"]["review"], Value::Null);
    let path = format!("/v1/agents/{agent}/models");
    let (status, view) = spade
        .put(&path, json!({ "efforts": { "main": "high" } }))
        .await?;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["overrides"]["efforts"]["main"], "high");
    assert_eq!(role(&view, "main")["effort"], "high");
    assert_eq!(role(&view, "main")["effort_source"], "bot");
    assert_eq!(role(&view, "title")["effort"], "off");
    assert_eq!(role(&view, "title")["effort_source"], "global");
    assert_eq!(role(&view, "review")["effort"], "medium");
    assert_eq!(role(&view, "review")["effort_source"], "default");

    spade.say(&conversation, "Once more").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    assert_eq!(sent(&spade, true)[1]["reasoning_effort"], "high");

    // Cleared, the bot's turns go back to the person's choice.
    let (_, view) = spade
        .put(&path, json!({ "efforts": { "main": null } }))
        .await?;
    assert_eq!(role(&view, "main")["effort"], "low");
    assert_eq!(role(&view, "main")["effort_source"], "global");
    Ok(())
}

#[tokio::test]
async fn the_provider_default_sends_no_reasoning_setting_and_unknown_words_are_refused() -> Result {
    let spade = Spade::start(vec![Script::reply("Hello."), title()], Vec::new()).await?;
    let (agent, conversation) = bot(&spade).await?;
    let path = format!("/v1/agents/{agent}/models");
    for refused in [
        json!({ "efforts": { "main": "extreme" } }),
        json!({ "efforts": { "advisor": "low" } }),
    ] {
        let (status, body) = spade.put(&path, refused.clone()).await?;
        assert_eq!(status, 400, "{refused} gave {body}");
    }
    let (status, body) = spade
        .put(&path, json!({ "efforts": { "main": "provider" } }))
        .await?;
    assert_eq!(status, 200, "{body}");
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;
    assert!(sent(&spade, true)[0].get("reasoning_effort").is_none());
    Ok(())
}

#[tokio::test]
async fn a_turn_on_an_endpoint_that_refuses_the_effort_still_answers() -> Result {
    let spade = Spade::start(
        vec![Script::failing(400), Script::reply("Hello."), title()],
        Vec::new(),
    )
    .await?;
    let (_, conversation) = bot(&spade).await?;
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;
    let events = spade.events(&conversation).await?;
    assert!(events.iter().any(|e| e["type"] == "reply_finished"));
    assert!(
        Value::Array(events).to_string().contains("Hello."),
        "the answer never arrived"
    );
    let turns = sent(&spade, true);
    assert_eq!(turns[0]["reasoning_effort"], "medium");
    assert!(turns[1].get("reasoning_effort").is_none());
    Ok(())
}
