//! `AceTools` against an in-process MCP server built with the same SDK as a real one.

mod support;

use std::time::Duration;

use serde_json::json;
use spade_ace::{AceTools, Part, Risk, Secret, ToolsConfig, ToolsError};
use support::fake_mcp::{FakeMcp, PIXEL, TOKEN, tool};

fn client(fake: &FakeMcp, token: &str, timeout: Duration) -> AceTools {
    AceTools::new(ToolsConfig {
        url: fake.url(),
        token: Secret::new(token),
        timeout,
    })
}

fn usual_tools() -> Vec<rmcp::model::Tool> {
    vec![
        tool("threads_find", Some(true), None),
        tool("echo", None, None),
        tool("thread_delete", Some(false), Some(true)),
        tool("snap", Some(true), Some(false)),
        tool("fail", None, None),
    ]
}

#[tokio::test]
async fn lists_every_page_with_risk_from_the_hints() {
    let fake = FakeMcp::start(usual_tools()).await;
    let tools = client(&fake, TOKEN, Duration::from_secs(5)).tools().await;
    let tools = tools.unwrap_or_else(|e| panic!("{e}"));
    let named: Vec<(&str, Risk)> = tools.iter().map(|t| (t.name.as_str(), t.risk)).collect();
    assert_eq!(
        named,
        vec![
            ("threads_find", Risk::Read),
            ("echo", Risk::Write),
            ("thread_delete", Risk::Destructive),
            ("snap", Risk::Read),
            ("fail", Risk::Write),
        ]
    );
    assert_eq!(tools[1].description, "echo does a thing");
    assert_eq!(
        tools[1].input_schema["properties"]["say"]["type"],
        json!("string")
    );
}

#[tokio::test]
async fn a_call_returns_text_and_images_and_tool_errors_are_results() {
    let fake = FakeMcp::start(usual_tools()).await;
    let tools = client(&fake, TOKEN, Duration::from_secs(5));

    let echo = tools.call("echo", json!({ "say": "hi" })).await;
    let echo = echo.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(echo.parts, vec![Part::Text("hi".into())]);
    assert!(!echo.is_error);

    let snap = tools.call("snap", serde_json::Value::Null).await;
    let snap = snap.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        snap.parts,
        vec![
            Part::Text("here it is".into()),
            Part::Image {
                mime_type: "image/png".into(),
                data: PIXEL.into()
            }
        ]
    );

    let fail = tools.call("fail", json!({})).await;
    let fail = fail.unwrap_or_else(|e| panic!("{e}"));
    assert!(fail.is_error);
    assert_eq!(
        fail.parts,
        vec![Part::Text("the thread is archived".into())]
    );
}

#[tokio::test]
async fn an_unknown_tool_is_a_server_error_and_bad_arguments_never_leave() {
    let fake = FakeMcp::start(usual_tools()).await;
    let tools = client(&fake, TOKEN, Duration::from_secs(5));
    match tools.call("nope", json!({})).await {
        Err(ToolsError::Server { message, .. }) => assert!(message.contains("unknown tool nope")),
        other => panic!("expected a server error, got {other:?}"),
    }
    assert_eq!(
        tools.call("echo", json!(["not", "an", "object"])).await,
        Err(ToolsError::InvalidArguments)
    );
}

#[tokio::test]
async fn a_list_change_from_the_daemon_refreshes_the_tools() {
    let fake = FakeMcp::start(usual_tools()).await;
    let tools = client(&fake, TOKEN, Duration::from_secs(5));
    let before = tools.tools().await.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(before.len(), 5);
    let mut changes = tools.changes();

    fake.add_tool_and_notify(tool("browser_open", None, None))
        .await;
    tokio::time::timeout(Duration::from_secs(5), changes.changed())
        .await
        .unwrap_or_else(|_| panic!("no list change arrived"))
        .unwrap_or_else(|e| panic!("{e}"));

    let after = tools.tools().await.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(after.len(), 6);
    assert_eq!(after[5].name, "browser_open");
}

#[tokio::test]
async fn a_session_lost_to_a_daemon_restart_is_opened_again() {
    let mut fake = FakeMcp::start(usual_tools()).await;
    let tools = client(&fake, TOKEN, Duration::from_secs(5));
    let first = tools.call("echo", json!({ "say": "one" })).await;
    assert_eq!(first.map(|r| r.parts), Ok(vec![Part::Text("one".into())]));

    fake.restart().await;

    let second = tools.call("echo", json!({ "say": "two" })).await;
    assert_eq!(second.map(|r| r.parts), Ok(vec![Part::Text("two".into())]));
    assert_eq!(tools.tools().await.map(|t| t.len()), Ok(5));
}

#[tokio::test]
async fn a_refused_token_is_named_and_never_echoed() {
    let fake = FakeMcp::start(usual_tools()).await;
    let wrong = "wrong-bearer-value";
    let tools = client(&fake, wrong, Duration::from_secs(5));
    let error = tools.tools().await.err();
    assert_eq!(error, Some(ToolsError::Refused));
    let error = tools.call("echo", json!({})).await.err();
    assert_eq!(error, Some(ToolsError::Refused));
    assert!(!format!("{error:?}").contains(wrong));
}

#[tokio::test]
async fn a_call_that_runs_too_long_times_out() {
    let fake = FakeMcp::start(usual_tools()).await;
    let tools = client(&fake, TOKEN, Duration::from_millis(400));
    assert_eq!(
        tools.call("slow", json!({})).await.err(),
        Some(ToolsError::Timeout)
    );
    // The session is still good afterwards.
    let echo = tools.call("echo", json!({ "say": "still here" })).await;
    assert_eq!(
        echo.map(|r| r.parts),
        Ok(vec![Part::Text("still here".into())])
    );
}

#[tokio::test]
async fn nothing_listening_is_unavailable() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("{e}"));
    let addr = listener.local_addr().unwrap_or_else(|e| panic!("{e}"));
    drop(listener);
    let tools = AceTools::new(ToolsConfig {
        url: format!("http://{addr}/mcp"),
        token: Secret::new(TOKEN),
        timeout: Duration::from_secs(5),
    });
    match tools.tools().await {
        Err(ToolsError::Unavailable(text)) => assert!(!text.contains(TOKEN)),
        other => panic!("expected unavailable, got {other:?}"),
    }
}
