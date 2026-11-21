//! What an app's MCP server says and asks, through Spade's API and engine (ADR 0202 §2), against
//! the fake app on 127.0.0.1 and a scripted model: its annotations lower nothing unless its
//! catalogue entry is trusted, a destructive hint asks every call, a form it sends mid-call is a
//! card whose answer goes back once, a form asking for a secret fails the call, and sampling is
//! refused.

mod support;

use serde_json::{Value, json};
use spade_testkit::connector::tool;
use spade_testkit::{FakeConnector, Script};
use support::{Options, Result, Spade};

/// Spade with the fake app as catalogue entry `fake`, its annotations trusted or not.
async fn with_app(app: &FakeConnector, trusted: bool, scripts: Vec<Script>) -> Result<Spade> {
    app.accept_token("api-key-1");
    let spade = Spade::start_with(
        scripts,
        Vec::new(),
        Options {
            connectors: true,
            catalogue: vec![spade_connect::Entry {
                id: "fake".into(),
                name: "Fake".into(),
                url: app.url(),
                sign_in: vec![spade_connect::SignIn::Token],
                source: "https://example.com/docs".into(),
                local: true,
                trusted_annotations: trusted,
                ..Default::default()
            }],
            ..Options::default()
        },
    )
    .await?;
    let (status, body) = spade
        .post(
            "/v1/connectors",
            json!({ "catalogue": "fake", "token": "api-key-1" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    for _ in 0..250 {
        let (_, body) = spade.get("/v1/connectors/fake").await?;
        if body["connector"]["tools"] != 0 {
            return Ok(spade);
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    Err("the fake app never listed its tools".into())
}

fn call(id: &str, tool: &str) -> Script {
    Script::reply("").call(
        id,
        "call_tool",
        json!({ "name": format!("fake__{tool}"), "arguments": {} }),
    )
}

/// The calls, then the reply and its title.
fn turn(calls: Vec<Script>) -> Vec<Script> {
    let mut scripts = calls;
    scripts.push(Script::reply("Done."));
    scripts.push(Script::reply("").plain(r#"{"title":"Apps"}"#));
    scripts
}

async fn main_conversation(spade: &Spade) -> Result<String> {
    let (_, body) = spade.get("/v1/agents").await?;
    body["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["kind"] == "main"))
        .and_then(|a| a["conversation"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| "no main agent".into())
}

fn of<'a>(events: &'a [Value], kind: &str, call: &str) -> Option<&'a Value> {
    events
        .iter()
        .find(|e| e["type"] == kind && e["call_id"] == call)
}

fn result<'a>(events: &'a [Value], call: &str) -> &'a str {
    of(events, "tool_finished", call)
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default()
}

async fn allow(spade: &Spade, conversation: &str, call: &str, always: bool) -> Result {
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/{call}"),
            json!({ "allowed": true, "always": always }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    Ok(())
}

#[tokio::test]
async fn a_trusted_apps_read_runs_without_asking_and_an_untrusted_apps_still_asks() -> Result {
    for trusted in [true, false] {
        let app = FakeConnector::start(vec![tool("echo", Some(true), None)]).await;
        let spade = with_app(&app, trusted, turn(vec![call("c1", "echo")])).await?;
        let main = main_conversation(&spade).await?;
        spade.say(&main, "Echo something").await?;
        let events = spade
            .wait_for_any(&main, &["approval_requested", "reply_finished"])
            .await?;
        let asked = of(&events, "approval_requested", "c1");
        if trusted {
            assert!(asked.is_none(), "a trusted read asked: {asked:?}");
            let events = spade.wait_for(&main, "reply_finished").await?;
            assert_eq!(result(&events, "c1"), "nothing");
        } else {
            // Its readOnlyHint is the server's own word: the person decides.
            let asked = asked.ok_or("an untrusted read ran without asking")?;
            assert_eq!(asked["ask"], "undeclared", "{asked}");
            assert_eq!(app.tool_runs(), 0, "it ran before the person answered");
        }
    }
    Ok(())
}

#[tokio::test]
async fn a_destructive_hint_asks_every_call_even_after_always_allow() -> Result {
    let app = FakeConnector::start(vec![tool("delete_project", None, Some(true))]).await;
    let spade = with_app(
        &app,
        true,
        turn(vec![
            call("c1", "delete_project"),
            call("c2", "delete_project"),
        ]),
    )
    .await?;
    let main = main_conversation(&spade).await?;
    spade.say(&main, "Delete it twice").await?;
    let events = spade.wait_for(&main, "approval_requested").await?;
    let asked = of(&events, "approval_requested", "c1").ok_or("the first call didn't ask")?;
    assert!(asked.to_string().contains("delete or overwrite"), "{asked}");
    allow(&spade, &main, "c1", true).await?;
    let events = spade.wait_for_count(&main, "approval_requested", 2).await?;
    assert!(
        of(&events, "approval_requested", "c2").is_some(),
        "an Always allow let a destructive call skip asking"
    );
    assert_eq!(app.tool_runs(), 1);
    Ok(())
}

#[tokio::test]
async fn an_apps_form_is_a_card_from_the_bot_and_its_answer_goes_back_once() -> Result {
    let app = FakeConnector::start(vec![tool("ask_name", Some(true), None)]).await;
    let spade = with_app(&app, true, turn(vec![call("c1", "ask_name")])).await?;
    let main = main_conversation(&spade).await?;
    spade.say(&main, "Make the card").await?;
    let events = spade.wait_for(&main, "question_asked").await?;
    let card = events
        .iter()
        .find(|e| e["type"] == "question_asked")
        .ok_or("no card")?;
    let card_id = card["call_id"].as_str().unwrap_or_default().to_owned();
    assert_ne!(card_id, "c1", "the card took the call's own id");
    assert!(
        card["question"]
            .as_str()
            .is_some_and(|q| q.starts_with("Fake asks: Which name goes on the card?")),
        "{card}"
    );
    // Nothing goes back to the app until the person answers on the card.
    assert_eq!(app.elicit_answers(), Vec::<Value>::new());

    let path = format!("/v1/conversations/{main}/questions/{card_id}");
    let (status, body) = spade.post(&path, json!({ "answers": ["Ada"] })).await?;
    assert_eq!(status, 202, "{body}");
    let events = spade.wait_for(&main, "reply_finished").await?;
    assert_eq!(result(&events, "c1"), "got Ada");
    let (status, _) = spade.post(&path, json!({ "answers": ["Bea"] })).await?;
    assert_eq!(status, 409, "a second answer was taken");
    assert_eq!(
        app.elicit_answers(),
        vec![json!({ "action": "accept", "content": { "name": "Ada" } })]
    );
    Ok(())
}

#[tokio::test]
async fn a_form_asking_for_a_secret_is_never_shown_and_fails_the_call() -> Result {
    let app = FakeConnector::start(vec![tool("ask_password", Some(true), None)]).await;
    let spade = with_app(&app, true, turn(vec![call("c1", "ask_password")])).await?;
    let main = main_conversation(&spade).await?;
    spade.say(&main, "Go on").await?;
    let events = spade.wait_for(&main, "reply_finished").await?;
    assert!(
        events.iter().all(|e| e["type"] != "question_asked"),
        "the form was shown"
    );
    let finished = of(&events, "tool_finished", "c1").ok_or("no result")?;
    assert_eq!(finished["is_error"], true, "{finished}");
    assert!(
        result(&events, "c1").starts_with("It asked for a secret in chat"),
        "{finished}"
    );
    assert_eq!(app.elicit_answers(), vec![json!({ "action": "decline" })]);
    Ok(())
}

#[tokio::test]
async fn an_app_asking_to_sample_the_persons_model_is_refused() -> Result {
    let app = FakeConnector::start(vec![tool("summarize", Some(true), None)]).await;
    let spade = with_app(&app, true, turn(vec![call("c1", "summarize")])).await?;
    let main = main_conversation(&spade).await?;
    spade.say(&main, "Summarize").await?;
    let events = spade.wait_for(&main, "reply_finished").await?;
    let said = result(&events, "c1");
    assert!(said.contains(spade_mcp::ask::SAMPLING_REFUSED), "{said}");
    Ok(())
}
