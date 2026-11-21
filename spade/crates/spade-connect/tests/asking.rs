//! An app's server asking mid-call (ADR 0202 §2), against the fake app on 127.0.0.1: a form it
//! sends during a call reaches that call's asker and its answer goes back once; with no asker the
//! form is declined; asking to sample the person's model is refused.

mod support;

use std::sync::{Arc, Mutex};

use serde_json::{Map, json};
use spade_mcp::{AskFuture, Asker, Form, Part, Reply};
use spade_testkit::FakeConnector;
use spade_testkit::connector::tool;
use support::{Result, signed_in, spade};

/// Plays the person: keeps every form it is shown and answers each with `reply`.
struct Person {
    shown: Mutex<Vec<Form>>,
    reply: Reply,
}

impl Asker for Person {
    fn ask(&self, form: Form) -> AskFuture {
        self.shown
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(form);
        let reply = self.reply.clone();
        Box::pin(async move { reply })
    }
}

fn text(result: &spade_mcp::McpToolResult) -> String {
    result
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

async fn fake_app() -> FakeConnector {
    FakeConnector::start(vec![
        tool("ask_name", None, None),
        tool("summarize", Some(true), None),
    ])
    .await
}

#[tokio::test]
async fn a_form_the_app_sends_mid_call_reaches_its_asker_and_the_answer_goes_back_once() -> Result {
    let app = fake_app().await;
    let spade = spade()?;
    let view = signed_in(&spade, &app).await?;
    let mut given = Map::new();
    given.insert("name".into(), json!("Ada"));
    let person = Arc::new(Person {
        shown: Mutex::default(),
        reply: Reply::Accept(given),
    });
    let result = spade
        .connectors
        .call_asking(&view.id, "ask_name", json!({}), Some(person.clone()))
        .await?;
    assert_eq!(text(&result), "got Ada");
    let shown = person
        .shown
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    assert_eq!(shown.len(), 1, "{shown:?}");
    assert_eq!(shown[0].message, "Which name goes on the card?");
    assert_eq!(shown[0].schema["properties"]["name"]["type"], "string");
    let answers = app.elicit_answers();
    assert_eq!(
        answers,
        vec![json!({ "action": "accept", "content": { "name": "Ada" } })]
    );
    Ok(())
}

#[tokio::test]
async fn a_form_during_a_call_no_one_can_show_is_declined() -> Result {
    let app = fake_app().await;
    let spade = spade()?;
    let view = signed_in(&spade, &app).await?;
    let result = spade
        .connectors
        .call(&view.id, "ask_name", json!({}))
        .await?;
    assert_eq!(text(&result), "the person chose decline");
    assert_eq!(app.elicit_answers(), vec![json!({ "action": "decline" })]);
    Ok(())
}

#[tokio::test]
async fn an_app_asking_to_sample_the_persons_model_is_refused() -> Result {
    let app = fake_app().await;
    let spade = spade()?;
    let view = signed_in(&spade, &app).await?;
    let person = Arc::new(Person {
        shown: Mutex::default(),
        reply: Reply::Cancel,
    });
    let result = spade
        .connectors
        .call_asking(&view.id, "summarize", json!({}), Some(person.clone()))
        .await?;
    let said = text(&result);
    assert!(said.starts_with("sampling failed"), "{said}");
    assert!(said.contains(spade_mcp::ask::SAMPLING_REFUSED), "{said}");
    assert!(
        person
            .shown
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty(),
        "sampling reached the person as a form"
    );
    Ok(())
}
