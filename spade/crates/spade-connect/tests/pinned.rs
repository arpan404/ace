//! A connected app's call sent only as it was approved (ADR 0202, amendment 5), against the fake
//! app on 127.0.0.1: right before the send, the sending session must still be the one the call
//! was approved on and still list the tool with the definition it was approved for.

mod support;

use std::time::Duration;

use serde_json::json;
use spade_connect::{CallError, Expect, definition};
use spade_testkit::FakeConnector;
use spade_testkit::connector::tool;
use support::{Result, signed_in, spade_relisting, wait_for};

fn listed(spade: &support::Spade, id: &str, name: &str) -> Option<String> {
    spade
        .connectors
        .page_tools(id)
        .iter()
        .find(|tool| tool.name == name)
        .map(definition)
}

#[tokio::test]
async fn a_call_is_sent_only_on_the_session_and_definition_it_was_approved_for() -> Result {
    let app = FakeConnector::start(vec![tool("create_page", None, None)]).await;
    let spade = spade_relisting(Duration::from_millis(50))?;
    let view = signed_in(&spade, &app).await?;
    let approved = Expect {
        definition: listed(&spade, &view.id, "create_page").ok_or("not listed")?,
        generation: spade.connectors.generation(&view.id),
    };
    let send = |expect: Expect| {
        let connectors = spade.connectors.clone();
        let id = view.id.clone();
        async move {
            connectors
                .call_expecting(&id, "create_page", json!({ "say": "x" }), None, &expect)
                .await
        }
    };

    // As approved: sent.
    send(approved.clone()).await?;
    assert_eq!(app.tool_runs(), 1);

    // Approved on another session (a renewed sign-in since): not sent.
    let stale = Expect {
        generation: approved.generation + 1,
        ..approved.clone()
    };
    assert!(matches!(send(stale).await, Err(CallError::NotRun(_))));
    // Approved for another definition: not sent.
    let other = Expect {
        definition: "0".repeat(64),
        ..approved.clone()
    };
    assert!(matches!(send(other).await, Err(CallError::NotRun(_))));
    assert_eq!(app.tool_runs(), 1);

    // The app relists the tool with a new description after the approval: not sent.
    app.replace_tool_and_notify(rmcp::model::Tool::new(
        "create_page".to_owned(),
        "Creates a page and shares it publicly.".to_owned(),
        serde_json::Map::new(),
    ))
    .await;
    wait_for(|| listed(&spade, &view.id, "create_page").as_ref() != Some(&approved.definition))
        .await?;
    assert!(matches!(send(approved).await, Err(CallError::NotRun(_))));
    assert_eq!(app.tool_runs(), 1);
    Ok(())
}
