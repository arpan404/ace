//! A packaged bot's call Spade's classifier raises to the person (ADR 0172) under its package's
//! ceiling (ADR 0200 §3.4): a send or payment the classifier reads in it is held to what the
//! package declared and the person left on, when it is decided and again when it starts.

mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::effect::Effect;
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::packaged::*;
use support::{FakeTool, Options, Result, Spade};

/// An app's tool its catalogue entry says reaches its server, which reads as sending a mail.
fn mailer() -> FakeTool {
    FakeTool::new("gmail__send_email", Risk::Write, "Sent")
        .app("Sends an email")
        .declares(Effect::Network)
}

fn send() -> Script {
    Script::reply("").call(
        "c1",
        "gmail__send_email",
        json!({ "to": "sam@example.com", "subject": "Fares", "body": "The fare dropped." }),
    )
}

/// A packaged bot's Spade with the classifier on, the fake model as reviewer.
async fn start(scripts: Vec<Script>, tools: Vec<Arc<dyn Tool>>) -> Result<Spade> {
    let options = Options {
        reviewer: None,
        classifier: true,
        ..Options::default()
    };
    let spade = Spade::start_with(scripts, tools, options).await?;
    secure(&spade).await?;
    Ok(spade)
}

fn asked(events: &[Value]) -> bool {
    events.iter().any(|e| e["type"] == "approval_requested")
}

#[tokio::test]
async fn a_send_the_classifier_reads_is_refused_when_the_package_left_sending_off() -> Result {
    let tool = mailer();
    let sent = tool.calls();
    let spade = start(
        vec![
            send(),
            Script::reply("Not sent."),
            Script::reply("").plain(r#"{"title":"T"}"#),
        ],
        vec![Arc::new(tool)],
    )
    .await?;
    let switches = json!({ "network:hosts:api.example-fares.com": true, "send_as_person": false });
    let agent = installed(&spade, switches, false).await?;
    let conversation = text(&agent["conversation"]);
    spade
        .say(&conversation, "Tell Sam the fare dropped")
        .await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    assert!(!asked(&events), "refused, never asked");
    let done = finished(&events, "c1").cloned().unwrap_or_default();
    assert!(
        done.to_string()
            .contains("Flight watcher doesn't declare sending in your name."),
        "{done}"
    );
    assert!(sent.lock().map(|c| c.is_empty()).unwrap_or(false));
    Ok(())
}

#[tokio::test]
async fn a_raised_send_the_person_allows_after_turning_sending_off_doesnt_run() -> Result {
    let tool = mailer();
    let sent = tool.calls();
    let spade = start(
        vec![
            send(),
            Script::reply("Not sent."),
            Script::reply("").plain(r#"{"title":"T"}"#),
        ],
        vec![Arc::new(tool)],
    )
    .await?;
    let agent = installed(&spade, hosts_on(), false).await?;
    let bot = text(&agent["id"]);
    let conversation = text(&agent["conversation"]);
    spade
        .say(&conversation, "Tell Sam the fare dropped")
        .await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    let request = events
        .iter()
        .find(|e| e["type"] == "approval_requested")
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        request["reviewer_reason"],
        "It sends something in your name, so you decide."
    );
    // Its own effect is `network`, which stays on; the send the classifier read is turned off.
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{bot}/package/effects"),
            json!({ "key": "send_as_person", "on": false }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/c1"),
            json!({ "allowed": true }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let done = finished(&events, "c1").cloned().unwrap_or_default();
    assert!(
        done.to_string()
            .contains("Flight watcher doesn't declare sending in your name."),
        "{done}"
    );
    assert!(sent.lock().map(|c| c.is_empty()).unwrap_or(false));
    Ok(())
}
