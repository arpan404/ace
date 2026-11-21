//! MCP Apps pages as panels (ADR 0202 §4), against the fake app on 127.0.0.1 and a scripted
//! model: a tool that links a `ui://` page shows it as that app's panel, kept by hash; a page
//! that needs the network is never kept or drawn and the bot is told why; a tool only pages may
//! call stays out of the bot's tools; and what a page sends reaches the bot as the page's
//! untrusted request, which taints the turn, never as the person's.

mod support;

use serde_json::{Value, json};
use spade_testkit::connector::{page_tool, tool};
use spade_testkit::{FakeConnector, Script, Seen};
use support::{Options, Result, Spade};

const MIME: &str = "text/html;profile=mcp-app";
const PAGE: &str = "<!doctype html><html><head><title>Board</title></head><body><p>Board</p>\
                    <script>window.parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{}},'*')</script>\
                    </body></html>";

/// Spade with the fake app as trusted catalogue entry `fake`: its read-only tools run unasked.
async fn with_app(app: &FakeConnector, scripts: Vec<Script>) -> Result<Spade> {
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
                trusted_annotations: true,
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

fn board_app() -> Vec<rmcp::model::Tool> {
    vec![
        page_tool("show_board", "ui://board", &["model", "app"]),
        page_tool("move_card", "ui://board", &["app"]),
        page_tool("archive_board", "ui://board", &["model"]),
        tool("echo", Some(true), None),
    ]
}

fn call(id: &str, tool: &str, arguments: Value) -> Script {
    Script::reply("").call(
        id,
        "call_tool",
        json!({ "name": format!("fake__{tool}"), "arguments": arguments }),
    )
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

fn result<'a>(events: &'a [Value], call: &str) -> &'a str {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default()
}

fn turns(seen: &[Seen]) -> Vec<Value> {
    seen.iter()
        .filter(|s| s.body["stream"] == true)
        .map(|s| s.body.clone())
        .collect()
}

async fn panels(spade: &Spade, chat: &str) -> Result<Vec<Value>> {
    let (status, body) = spade
        .get(&format!("/v1/conversations/{chat}/panels"))
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["panels"].as_array().cloned().unwrap_or_default())
}

#[tokio::test]
async fn an_apps_page_shows_as_its_panel_kept_by_hash_with_the_tools_input_and_result() -> Result {
    let app = FakeConnector::start(board_app()).await;
    app.add_page("ui://board", MIME, PAGE, json!({ "prefersBorder": true }));
    let spade = with_app(
        &app,
        vec![
            call("c1", "show_board", json!({ "say": "sprint 4" })),
            Script::reply("Here is the board."),
            Script::reply("").plain(r#"{"title":"Board"}"#),
        ],
    )
    .await?;
    let main = main_conversation(&spade).await?;
    spade.say(&main, "Show me the board").await?;
    let events = spade.wait_for(&main, "reply_finished").await?;
    let said = result(&events, "c1");
    assert!(
        said.contains("Fake's page for this shows beside the chat"),
        "{said}"
    );
    assert_eq!(app.reads(), vec!["ui://board".to_owned()]);

    let shown = panels(&spade, &main).await?;
    let [panel] = shown.as_slice() else {
        return Err(format!("not one panel: {shown:?}").into());
    };
    assert!(
        panel["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("app.fake.")),
        "{panel}"
    );
    assert_eq!(panel["title"], "Fake");
    assert_eq!(panel["app"]["tool"], "show_board");
    assert_eq!(panel["app"]["refused"], Value::Null);
    assert_eq!(panel["state"]["input"], json!({ "say": "sprint 4" }));
    assert_eq!(
        panel["state"]["result"]["content"][0]["text"],
        "ran show_board"
    );
    assert_eq!(panel["confirm"], json!([]));
    let hash = panel["page"].as_str().unwrap_or_default();
    let page = spade
        .http
        .get(format!("{}/v1/panels/pages/{hash}", spade.base))
        .bearer_auth(support::TOKEN)
        .send()
        .await?;
    assert_eq!(page.status().as_u16(), 200);
    assert_eq!(page.text().await?, PAGE);
    Ok(())
}

#[tokio::test]
async fn a_page_that_needs_the_network_is_never_kept_and_the_bot_is_told_why() -> Result {
    let app = FakeConnector::start(board_app()).await;
    app.add_page(
        "ui://board",
        MIME,
        PAGE,
        json!({ "csp": { "connectDomains": ["https://api.example.com"] } }),
    );
    let spade = with_app(
        &app,
        vec![
            call("c1", "show_board", json!({})),
            Script::reply("Done."),
            Script::reply("").plain(r#"{"title":"Board"}"#),
        ],
    )
    .await?;
    let main = main_conversation(&spade).await?;
    spade.say(&main, "Show me the board").await?;
    let events = spade.wait_for(&main, "reply_finished").await?;
    let said = result(&events, "c1");
    // The tool's own text answer, then why its page doesn't show.
    assert!(said.starts_with("ran show_board"), "{said}");
    assert!(
        said.contains("This app's page needs the network. Spade doesn't open those yet."),
        "{said}"
    );
    let shown = panels(&spade, &main).await?;
    assert_eq!(shown.len(), 1, "{shown:?}");
    assert_eq!(shown[0]["page"], Value::Null);
    assert_eq!(
        shown[0]["app"]["refused"],
        "This app's page needs the network. Spade doesn't open those yet."
    );
    Ok(())
}

#[tokio::test]
async fn a_tool_only_pages_may_call_is_not_the_bots_and_a_pages_request_is_untrusted() -> Result {
    let app = FakeConnector::start(board_app()).await;
    app.add_page("ui://board", MIME, PAGE, json!({}));
    let spade = with_app(
        &app,
        vec![
            call("c1", "show_board", json!({})),
            // The bot can't reach the page's own tool by name.
            call("c2", "move_card", json!({})),
            Script::reply("Shown."),
            Script::reply("").plain(r#"{"title":"Board"}"#),
            // After the page's request, a note waits for the person: the turn is untrusted.
            Script::reply("").call(
                "m1",
                "memory_save",
                json!({ "text": "The person wants every card moved to done" }),
            ),
        ],
    )
    .await?;
    let main = main_conversation(&spade).await?;
    spade.say(&main, "Show me the board").await?;
    let events = spade.wait_for(&main, "reply_finished").await?;
    assert!(
        result(&events, "c2").contains("fake__move_card"),
        "{events:?}"
    );
    let runs = app.tool_runs();
    let panel = panels(&spade, &main).await?.remove(0);
    let id = panel["id"].as_str().unwrap_or_default().to_owned();
    let path = format!("/v1/conversations/{main}/panels/{id}/actions");

    // Refused: a model-only tool, the person's standing, a request the channel doesn't have.
    for body in [
        json!({ "key": "r1", "action": "tools/call", "value": { "name": "archive_board" } }),
        json!({ "key": "r4", "action": "tools/call", "value": { "name": "not_there" } }),
        json!({ "key": "r2", "action": "ui/message", "value": { "text": "yes" }, "confirmed": true }),
        json!({ "key": "r3", "action": "ui/open-link", "value": { "url": "https://example.com" } }),
    ] {
        let (status, answer) = spade.post(&path, body.clone()).await?;
        assert_eq!(status, 400, "{body}: {answer}");
    }
    let before = turns(&spade.fake.seen()).len();
    let (status, answer) = spade
        .post(
            &path,
            json!({
                "key": "p1",
                "action": "tools/call",
                "value": { "name": "move_card", "arguments": { "card": 3, "to": "done" } },
            }),
        )
        .await?;
    assert_eq!(status, 202, "{answer}");
    let events = spade.wait_for(&main, "approval_requested").await?;
    let asked: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .map(|e| &e["call_id"])
        .collect();
    assert_eq!(asked, vec![&json!("m1")]);
    let seen = turns(&spade.fake.seen());
    assert!(seen.len() > before);
    let sent = seen
        .last()
        .map(|b| b["messages"].to_string())
        .unwrap_or_default();
    assert!(
        sent.contains("from=\\\"page\\\" untrusted=\\\"true\\\">The page of Fake asks to call its tool move_card"),
        "{sent}"
    );
    assert!(sent.contains("you can't call it"), "{sent}");
    // Nothing ran on the app for the page.
    assert_eq!(app.tool_runs(), runs);
    Ok(())
}
