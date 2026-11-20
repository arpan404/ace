//! A bot asking the person for an app (ADR 0131, amendment 1), through Spade's API and engine
//! against a fake app and OAuth server on 127.0.0.1: the card it shows, the person connecting
//! (or not), the turn carrying on, and a call whose sign-in expired waiting on Reconnect.

mod support;

use serde_json::{Value, json};
use spade_testkit::connector::tool;
use spade_testkit::{FakeConnector, Script};
use support::{Options, Result, Spade};

fn app_tools() -> Vec<rmcp::model::Tool> {
    vec![tool("echo", Some(true), None)]
}

/// A catalogue entry for the fake app: one click when `ready`, else coming soon.
fn entry(app: &FakeConnector, id: &str, ready: bool) -> spade_connect::Entry {
    spade_connect::Entry {
        id: id.into(),
        name: if ready { "Fake" } else { "Soon" }.into(),
        url: app.url(),
        sign_in: vec![if ready {
            spade_connect::SignIn::Oauth
        } else {
            spade_connect::SignIn::OauthClient
        }],
        source: "https://example.com/docs".into(),
        local: true,
        ..Default::default()
    }
}

async fn spade_with(app: &FakeConnector, scripts: Vec<Script>) -> Result<Spade> {
    Spade::start_with(
        scripts,
        Vec::new(),
        Options {
            connectors: true,
            catalogue: vec![entry(app, "fake", true), entry(app, "soon", false)],
            ..Options::default()
        },
    )
    .await
}

fn ask(call: &str, app: &str) -> Script {
    Script::reply("").call(
        call,
        "app_connect_request",
        json!({ "app": app, "why": "To read your board" }),
    )
}

fn echo(call: &str, say: &str) -> Script {
    Script::reply("").call(
        call,
        "call_tool",
        json!({ "name": "fake__echo", "arguments": { "say": say } }),
    )
}

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Board"}"#)
}

fn find<'a>(events: &'a [Value], kind: &str, call: &str) -> Option<&'a Value> {
    events
        .iter()
        .rev()
        .find(|e| e["type"] == kind && e["call_id"] == call)
}

fn result(events: &[Value], call: &str) -> String {
    find(events, "tool_finished", call)
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/// The person signs in to `catalogue` in the browser, as the card's Connect does.
async fn sign_in(spade: &Spade, app: &FakeConnector, start: &str, body: Value) -> Result<String> {
    let (status, started) = spade.post(start, body).await?;
    assert_eq!(status, 202, "{started}");
    let id = started["id"].as_str().unwrap_or_default().to_owned();
    let back = app
        .approve(started["sign_in_url"].as_str().unwrap_or_default())
        .await;
    let page = reqwest::get(&back).await?;
    assert_eq!(page.status().as_u16(), 200);
    for _ in 0..250 {
        let (_, body) = spade.get(&format!("/v1/connectors/{id}")).await?;
        if body["connector"]["state"] == "connected" && body["connector"]["tools"] != 0 {
            return Ok(id);
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    Err(format!("{id} never connected").into())
}

async fn connected(spade: &Spade, conversation: &str, call: &str, connector: &str) -> Result {
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/questions/{call}/connected"),
            json!({ "connector": connector }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    Ok(())
}

/// Waits for `kind` (the `count`th of them), allowing each call the bot asks to run on the way, as
/// the person would: the fake app's tools declare nothing, so each asks once.
async fn allowing_until(
    spade: &Spade,
    conversation: &str,
    kind: &str,
    count: usize,
) -> Result<Vec<Value>> {
    for _ in 0..500 {
        let events = spade.events(conversation).await?;
        if events.iter().filter(|e| e["type"] == kind).count() >= count {
            return Ok(events);
        }
        for asked in events.iter().filter(|e| e["type"] == "approval_requested") {
            let call = asked["call_id"].as_str().unwrap_or_default();
            if find(&events, "approval_answered", call).is_none() {
                spade
                    .post(
                        &format!("/v1/conversations/{conversation}/approvals/{call}"),
                        json!({ "allowed": true }),
                    )
                    .await?;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    Err(format!("no {kind} in {conversation}").into())
}

async fn waiting_for(spade: &Spade, bot: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["id"] == bot))
        .map(|a| a["waiting_for"].clone())
        .unwrap_or(Value::Null))
}

async fn new_bot(spade: &Spade) -> Result<(String, String)> {
    let bot = spade.new_agent("Boards", "").await?;
    Ok((
        bot["id"].as_str().unwrap_or_default().to_owned(),
        bot["conversation"].as_str().unwrap_or_default().to_owned(),
    ))
}

#[tokio::test]
async fn a_bot_asking_for_an_unconnected_app_shows_a_connect_card_and_continues_after_the_person_connects()
-> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade_with(
        &app,
        vec![
            ask("c1", "fake"),
            echo("c2", "board"),
            Script::reply("Here it is."),
            title(),
        ],
    )
    .await?;
    let (bot, conversation) = new_bot(&spade).await?;
    spade.say(&conversation, "What's on my board?").await?;

    let events = allowing_until(&spade, &conversation, "question_asked", 1).await?;
    let card = &find(&events, "question_asked", "c1").ok_or("no card")?["questions"][0];
    assert_eq!(card["kind"], "connect");
    assert_eq!(card["app"], "fake");
    assert_eq!(card["name"], "Fake");
    assert_eq!(card["way"], "sign_in");
    assert_eq!(card["prompt"], "To read your board");
    assert_eq!(card["can"][0], "Read and change what your Fake account can");
    assert_eq!(waiting_for(&spade, &bot).await?, "question");

    let id = sign_in(
        &spade,
        &app,
        "/v1/connectors",
        json!({ "catalogue": "fake" }),
    )
    .await?;
    connected(&spade, &conversation, "c1", &id).await?;

    let events = allowing_until(&spade, &conversation, "reply_finished", 1).await?;
    let said = result(&events, "c1");
    assert!(
        said.contains("connected Fake as person@example.com"),
        "{said}"
    );
    // The app's tools are the bot's from its next step, with nothing retyped.
    assert_eq!(result(&events, "c2"), "board");
    let (_, allowed) = spade.get(&format!("/v1/agents/{bot}/connectors")).await?;
    assert_eq!(allowed, json!({ "all": false, "connectors": [id] }));
    Ok(())
}

#[tokio::test]
async fn the_bot_cant_connect_an_app_by_itself() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    app.accept_token("sk-from-the-bot");
    let spade = spade_with(
        &app,
        vec![
            Script::reply("").call(
                "c1",
                "app_connect_request",
                json!({ "app": "fake", "why": "To read", "token": "sk-from-the-bot" }),
            ),
            ask("c2", "fake"),
        ],
    )
    .await?;
    let (bot, conversation) = new_bot(&spade).await?;
    spade.say(&conversation, "Connect my board").await?;

    let events = allowing_until(&spade, &conversation, "question_asked", 1).await?;
    // Handing it a key is refused, and nothing was stored or sent for it.
    assert!(result(&events, "c1").contains("Only the person connects an app"));
    assert!(find(&events, "question_asked", "c1").is_none());
    // The card it may make waits on the person: nothing is connected meanwhile.
    assert_eq!(waiting_for(&spade, &bot).await?, "question");
    let (_, listed) = spade.get("/v1/connectors").await?;
    assert_eq!(listed["connectors"], json!([]));
    // An answer naming a connector that isn't there is refused, and the bot still waits.
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{conversation}/questions/c2/connected"),
            json!({ "connector": "fake" }),
        )
        .await?;
    assert_eq!(status, 400);
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{conversation}/questions/c2"),
            json!({ "answers": [{ "connector": "fake" }] }),
        )
        .await?;
    assert_eq!(status, 400);
    assert_eq!(waiting_for(&spade, &bot).await?, "question");
    assert_eq!(app.token_requests(), 0);
    Ok(())
}

#[tokio::test]
async fn not_now_lets_the_bot_carry_on() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade_with(
        &app,
        vec![
            ask("c1", "fake"),
            Script::reply("I'll go on without it."),
            title(),
        ],
    )
    .await?;
    let (bot, conversation) = new_bot(&spade).await?;
    spade.say(&conversation, "What's on my board?").await?;
    allowing_until(&spade, &conversation, "question_asked", 1).await?;
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{conversation}/questions/c1"),
            json!({ "dismiss": true }),
        )
        .await?;
    assert_eq!(status, 202);
    let events = allowing_until(&spade, &conversation, "reply_finished", 1).await?;
    let said = result(&events, "c1");
    assert!(said.contains("chose not to connect Fake"), "{said}");
    assert_eq!(waiting_for(&spade, &bot).await?, Value::Null);
    Ok(())
}

#[tokio::test]
async fn later_lets_the_bot_carry_on_and_connecting_afterwards_reaches_it() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade_with(
        &app,
        vec![
            ask("c1", "fake"),
            Script::reply("When it's connected I'll look."),
            title(),
            echo("c2", "now"),
            Script::reply("Now I can see it."),
        ],
    )
    .await?;
    let (_, conversation) = new_bot(&spade).await?;
    spade.say(&conversation, "What's on my board?").await?;
    allowing_until(&spade, &conversation, "question_asked", 1).await?;
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{conversation}/questions/c1"),
            json!({ "defer": true }),
        )
        .await?;
    assert_eq!(status, 202);
    let events = allowing_until(&spade, &conversation, "reply_finished", 1).await?;
    assert!(result(&events, "c1").contains("will connect Fake later"));

    let id = sign_in(
        &spade,
        &app,
        "/v1/connectors",
        json!({ "catalogue": "fake" }),
    )
    .await?;
    connected(&spade, &conversation, "c1", &id).await?;
    let events = allowing_until(&spade, &conversation, "reply_finished", 2).await?;
    assert_eq!(result(&events, "c2"), "now");
    Ok(())
}

#[tokio::test]
async fn an_expired_sign_in_shows_reconnect_and_retries_the_call() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade_with(
        &app,
        vec![echo("c1", "again"), Script::reply("Done."), title()],
    )
    .await?;
    let id = sign_in(
        &spade,
        &app,
        "/v1/connectors",
        json!({ "catalogue": "fake" }),
    )
    .await?;
    app.expire_access_tokens();
    app.revoke_refresh_tokens();
    let runs = app.tool_runs();

    let (_, agents) = spade.get("/v1/agents").await?;
    let main = agents["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["kind"] == "main"))
        .ok_or("no main bot")?
        .clone();
    let conversation = main["conversation"].as_str().unwrap_or_default().to_owned();
    spade.say(&conversation, "Echo again").await?;

    let events = allowing_until(&spade, &conversation, "question_asked", 1).await?;
    let card = &find(&events, "question_asked", "c1").ok_or("no card")?["questions"][0];
    assert_eq!(card["kind"], "connect");
    assert_eq!(card["way"], "reconnect");
    assert_eq!(card["retry"], true);
    assert_eq!(card["connector"], id);
    // No result reached the bot: the call waits on the person, not as a raw refusal.
    assert!(find(&events, "tool_finished", "c1").is_none());
    let main_id = main["id"].as_str().unwrap_or_default();
    assert_eq!(waiting_for(&spade, main_id).await?, "question");

    sign_in(
        &spade,
        &app,
        &format!("/v1/connectors/{id}/connect"),
        json!({}),
    )
    .await?;
    connected(&spade, &conversation, "c1", &id).await?;
    let events = allowing_until(&spade, &conversation, "reply_finished", 1).await?;
    assert_eq!(result(&events, "c1"), "again");
    assert_eq!(app.tool_runs(), runs + 1, "it ran once, after reconnecting");
    Ok(())
}

#[tokio::test]
async fn an_app_connected_once_can_be_given_to_another_bot_without_signing_in_again() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade_with(
        &app,
        vec![
            ask("c1", "fake"),
            echo("c2", "shared"),
            Script::reply("Got it."),
            title(),
        ],
    )
    .await?;
    let id = sign_in(
        &spade,
        &app,
        "/v1/connectors",
        json!({ "catalogue": "fake" }),
    )
    .await?;
    let sign_ins = app.token_requests();
    let (bot, conversation) = new_bot(&spade).await?;
    spade.say(&conversation, "What's on my board?").await?;

    let events = allowing_until(&spade, &conversation, "question_asked", 1).await?;
    let card = &find(&events, "question_asked", "c1").ok_or("no card")?["questions"][0];
    assert_eq!(card["way"], "use");
    assert_eq!(card["connector"], id);
    connected(&spade, &conversation, "c1", &id).await?;

    let events = allowing_until(&spade, &conversation, "reply_finished", 1).await?;
    assert_eq!(result(&events, "c2"), "shared");
    assert_eq!(app.token_requests(), sign_ins, "no second sign-in");
    let (_, allowed) = spade.get(&format!("/v1/agents/{bot}/connectors")).await?;
    assert_eq!(allowed["connectors"], json!([id]));
    Ok(())
}

#[tokio::test]
async fn a_coming_soon_apps_card_says_it_isnt_available_yet() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade_with(
        &app,
        vec![
            ask("c1", "soon"),
            Script::reply("It isn't available yet."),
            title(),
        ],
    )
    .await?;
    let (bot, conversation) = new_bot(&spade).await?;
    spade.say(&conversation, "What's on my board?").await?;

    let events = allowing_until(&spade, &conversation, "reply_finished", 1).await?;
    let card = &find(&events, "question_asked", "c1").ok_or("no card")?["questions"][0];
    assert_eq!(card["way"], "later");
    assert!(find(&events, "question_dismissed", "c1").is_some());
    assert!(result(&events, "c1").contains("Soon can't be connected yet"));
    // Nothing waits on the person for an app they can't connect.
    assert_eq!(waiting_for(&spade, &bot).await?, Value::Null);
    Ok(())
}
