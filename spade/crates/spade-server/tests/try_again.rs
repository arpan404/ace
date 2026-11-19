//! Try again on a failed reply (docs/chat-core.md), and a first run with no model, through the
//! real engine and API on a scripted fake endpoint.

mod support;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::{Options, Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"A title"}"#)
}

fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

/// The user messages the model was sent on its streamed calls, in order, per call.
fn asked(spade: &Spade) -> Vec<Vec<String>> {
    spade
        .fake
        .seen()
        .iter()
        .filter(|s| s.body["stream"] == true)
        .map(|s| {
            s.body["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|m| m["role"] == "user")
                .map(|m| m["content"].to_string())
                .collect()
        })
        .collect()
}

#[tokio::test]
async fn try_again_answers_the_failed_turn_in_place_without_posting_the_message_twice() -> Result {
    let spade = Spade::start(
        vec![Script::failing(400), Script::reply("Here you go."), title()],
        Vec::new(),
    )
    .await?;
    let id = spade.ask("Hello").await?;
    let events = spade.wait_for(&id, "reply_failed").await?;
    let failed = events
        .iter()
        .find(|e| e["type"] == "reply_failed")
        .and_then(|e| e["reply"].as_str())
        .unwrap_or_default()
        .to_owned();

    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{id}/retry"),
            json!({ "reply": failed }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    let events = spade.wait_for(&id, "reply_finished").await?;

    assert_eq!(
        count(&events, "user_message"),
        1,
        "the message is posted once"
    );
    let retried = events
        .iter()
        .position(|e| e["type"] == "reply_retried")
        .ok_or("no reply_retried")?;
    assert_eq!(events[retried]["reply"], failed.as_str());
    assert_eq!(
        events[retried + 1]["type"],
        "reply_started",
        "the new reply opens with the retry, in one write"
    );
    let calls = asked(&spade);
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(
        calls[1].len(),
        1,
        "the model reads the message once: {calls:?}"
    );
    assert!(calls[1][0].contains("Hello"));

    // Only the last reply, and only while it failed.
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{id}/retry"),
            json!({ "reply": failed }),
        )
        .await?;
    assert_eq!(status, 409, "{body}");
    Ok(())
}

#[tokio::test]
async fn spade_has_no_model_until_one_is_chosen_and_holds_messages_until_then() -> Result {
    let spade = Spade::start_with(
        vec![Script::reply("Hi."), title()],
        Vec::new(),
        Options {
            no_env_keys: true,
            // The review endpoint is a preset too, so there is none to review with either.
            reviewer: None,
            ..Options::default()
        },
    )
    .await?;
    let (_, body) = spade.get("/v1/agents").await?;
    let main = body["agents"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["kind"] == "main"))
        .cloned()
        .ok_or("no Spade")?;
    assert_eq!(
        main["model"], "",
        "no preset's model stands in for the person's choice"
    );
    let conversation = main["conversation"].as_str().unwrap_or_default();

    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "hello" }),
        )
        .await?;
    assert_eq!(status, 409, "{body}");
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|e| e.contains("choose one")),
        "it says what to do: {body}"
    );
    assert_eq!(count(&spade.events(conversation).await?, "user_message"), 0);
    Ok(())
}
