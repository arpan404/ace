//! A connected app whose server annotates nothing, as Notion's doesn't (ADR 0202, amendment 5),
//! against a fake app on 127.0.0.1: its reads run with no card and no reviewer, its writes go to
//! the reviewer and reach the person only when it won't approve them, a send still goes to the
//! person, and the person's Always allow for the app's writes needs their stamp and holds for
//! that bot only.

mod support;

use serde_json::{Value, json};
use spade_testkit::connector::tool;
use spade_testkit::{FakeConnector, Script};
use support::sandbox::world_with_options;
use support::{Options, Result, Spade};

const APPROVE: &str = r#"{"verdict":"approve","reason":"It serves the task."}"#;
const REFUSE: &str = r#"{"verdict":"refuse","reason":"Not plainly asked for."}"#;
const APP: &str = "127-0-0-1";

fn notion_tools() -> Vec<rmcp::model::Tool> {
    [
        "list_shared_pages",
        "list_favorite_pages",
        "list_recent_pages",
        "create_page",
        "send_email",
    ]
    .into_iter()
    .map(|name| tool(name, None, None))
    .collect()
}

fn use_tool(call: &str, name: &str) -> Script {
    Script::reply("").call(
        call,
        "call_tool",
        json!({ "name": format!("{APP}__{name}"), "arguments": { "say": call } }),
    )
}

/// One reply making several calls at once.
fn at_once(calls: &[(&str, &str)]) -> Script {
    calls
        .iter()
        .fold(Script::reply(""), |script, (call, name)| {
            script.call(
                call,
                "call_tool",
                json!({ "name": format!("{APP}__{name}"), "arguments": { "say": call } }),
            )
        })
}

fn of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == kind).collect()
}

fn asked<'a>(events: &'a [Value], call: &str) -> Option<&'a Value> {
    events
        .iter()
        .find(|e| e["type"] == "approval_requested" && e["call_id"] == call)
}

/// Whether the reviewer judged `call`: a review by a model, not the rules' own verdict.
fn reviewed(events: &[Value], call: &str) -> bool {
    events.iter().any(|e| {
        e["type"] == "call_reviewed"
            && e["call_id"] == call
            && e["model"].as_str().is_some_and(|model| !model.is_empty())
    })
}

/// Whether `call` ran in the app: its result is the app's.
fn ran(events: &[Value], call: &str) -> bool {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        .and_then(|e| e["content"].as_str())
        .is_some_and(|said| said.starts_with("ran "))
}

async fn agents(spade: &Spade) -> Result<Vec<Value>> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"].as_array().cloned().unwrap_or_default())
}

#[tokio::test]
async fn an_unannotated_apps_reads_run_freely_and_its_writes_follow_the_reviewer_and_the_person()
-> Result {
    let app = FakeConnector::start(notion_tools()).await;
    app.accept_token("api-key-1");
    let world = world_with_options(
        Options {
            connectors: true,
            // The reviewer is the scripted model, so a review reads the next script.
            reviewer: None,
            ..Options::default()
        },
        false,
        |_| {
            vec![
                // "See what you can see in my Notion": three reads at once, no card, no reviewer.
                at_once(&[
                    ("c1", "list_shared_pages"),
                    ("c2", "list_favorite_pages"),
                    ("c3", "list_recent_pages"),
                ]),
                Script::reply("Here they are."),
                Script::reply("").plain(r#"{"title":"Notion"}"#),
                // Three writes at once, after reading the app's pages: the person decides.
                at_once(&[
                    ("c4", "create_page"),
                    ("c5", "create_page"),
                    ("c6", "create_page"),
                ]),
                Script::reply("Made."),
                // Quill, Always allowed the app's writes: a write runs unreviewed; a send still asks.
                use_tool("c7", "create_page"),
                use_tool("c8", "send_email"),
                Script::reply("Not sent."),
                Script::reply("").plain(r#"{"title":"Pages"}"#),
                // Quill again, with the app's pages in view now: the reviewer checks its write.
                use_tool("c9", "create_page"),
                Script::reply("").plain(APPROVE),
                Script::reply("Made again."),
                // A bot with no Always allow of its own: before anything untrusted is in view, its
                // write goes to the reviewer, which won't approve it, so the person decides.
                use_tool("c10", "create_page"),
                Script::reply("").plain(REFUSE),
            ]
        },
    )
    .await?;
    let spade = &world.spade;
    let (status, body) = spade
        .post(
            "/v1/connectors",
            json!({ "url": app.url(), "name": "Notion", "local": true, "token": "api-key-1" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let main = agents(spade)
        .await?
        .into_iter()
        .find(|a| a["kind"] == "main")
        .ok_or("no main bot")?;
    let conversation = main["conversation"].as_str().unwrap_or_default().to_owned();

    spade
        .say(&conversation, "see what you can see in my notion")
        .await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    assert!(
        of_type(&events, "approval_requested").is_empty(),
        "{events:?}"
    );
    for call in ["c1", "c2", "c3"] {
        assert!(ran(&events, call), "{call} ran");
        assert!(!reviewed(&events, call), "{call} reviewed");
    }

    spade.say(&conversation, "make three pages").await?;
    let events = spade
        .wait_for_count(&conversation, "approval_requested", 3)
        .await?;
    for call in ["c4", "c5", "c6"] {
        let request = asked(&events, call).ok_or("not asked")?;
        assert!(!reviewed(&events, call), "{call} reviewed");
        assert!(
            request["reviewer_reason"]
                .as_str()
                .is_some_and(|line| line.contains("may change something in the app")),
            "{request}"
        );
        // Each offers the Always allow for the app's writes.
        assert_eq!(request["ask"], "app", "{request}");
        assert_eq!(request["app"], APP, "{request}");
    }
    for call in ["c4", "c5", "c6"] {
        let (status, body) = spade
            .post(
                &format!("/v1/conversations/{conversation}/approvals/{call}"),
                json!({ "allowed": true }),
            )
            .await?;
        assert_eq!(status, 202, "{body}");
    }
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    for call in ["c4", "c5", "c6"] {
        assert!(ran(&events, call), "{call}");
    }

    let quill = spade.new_agent("Quill", "").await?;
    let (quill_id, quill_conversation) = (
        quill["id"].as_str().unwrap_or_default().to_owned(),
        quill["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    );
    let (status, _) = spade
        .put(
            &format!("/v1/agents/{quill_id}/connectors"),
            json!({ "connectors": [APP] }),
        )
        .await?;
    assert_eq!(status, 200);
    // The bot holds Spade's token too: without the person's stamp the Always allow is refused.
    let writes = json!({ "kind": "app", "app": APP, "writes": true });
    let (status, _) = spade
        .post_unstamped(&format!("/v1/agents/{quill_id}/grants"), writes.clone())
        .await?;
    assert_eq!(status, 403);
    let (status, body) = spade
        .post(&format!("/v1/agents/{quill_id}/grants"), writes)
        .await?;
    assert_eq!(status, 201, "{body}");

    spade
        .say(&quill_conversation, "make a page and mail it")
        .await?;
    let events = spade
        .wait_for(&quill_conversation, "approval_requested")
        .await?;
    assert!(ran(&events, "c7"), "always allowed");
    assert!(!reviewed(&events, "c7"));
    let send = asked(&events, "c8").ok_or("the send wasn't asked")?;
    assert_ne!(send["ask"], "app", "no Always allow covers a send");
    assert!(
        send["reviewer_reason"]
            .as_str()
            .is_some_and(|line| line.contains("in your name")),
        "{send}"
    );
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{quill_conversation}/approvals/c8"),
            json!({ "allowed": false }),
        )
        .await?;
    assert_eq!(status, 202);
    spade
        .wait_for(&quill_conversation, "reply_finished")
        .await?;
    spade.say(&quill_conversation, "one more").await?;
    let events = spade
        .wait_for_count(&quill_conversation, "reply_finished", 2)
        .await?;
    assert!(reviewed(&events, "c9"), "checked under untrusted content");
    assert!(ran(&events, "c9"));

    let other = spade.new_agent("Scribe", "").await?;
    let (other_id, other_conversation) = (
        other["id"].as_str().unwrap_or_default().to_owned(),
        other["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    );
    let (status, _) = spade
        .put(
            &format!("/v1/agents/{other_id}/connectors"),
            json!({ "connectors": [APP] }),
        )
        .await?;
    assert_eq!(status, 200);
    spade.say(&other_conversation, "make a page").await?;
    let events = spade
        .wait_for(&other_conversation, "approval_requested")
        .await?;
    assert!(reviewed(&events, "c10"), "{events:?}");
    assert!(!ran(&events, "c10"));
    assert_eq!(
        asked(&events, "c10").map(|r| &r["ask"]),
        Some(&json!("app"))
    );
    Ok(())
}
