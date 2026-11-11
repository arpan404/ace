//! `AceTools` against an in-process MCP server built with the same SDK, holding to the daemon's
//! rules on sessions, headers and bearers.

mod support;

use std::time::Duration;

use serde_json::{Map, json};
use spade_ace::{AceTools, LoopbackUrl, Part, Risk, Secret, ToolsConfig, ToolsError};
use support::fake_mcp::{FakeMcp, PIXEL, TOKEN, tool};

fn config(url: &str, token: &str, timeout: Duration) -> ToolsConfig {
    let url = LoopbackUrl::parse(url).unwrap_or_else(|e| panic!("{e}"));
    ToolsConfig::new(url, Secret::new(token), timeout).unwrap_or_else(|e| panic!("{e}"))
}

fn client(fake: &FakeMcp, token: &str, timeout: Duration) -> AceTools {
    AceTools::new(config(&fake.url(), token, timeout))
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

fn names(tools: &[spade_ace::AceTool]) -> Vec<&str> {
    tools.iter().map(|t| t.name.as_str()).collect()
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
async fn every_request_asks_for_a_stream_and_none_narrows_the_listing() {
    let fake = FakeMcp::start(usual_tools()).await;
    let tools = client(&fake, TOKEN, Duration::from_secs(5));
    assert!(tools.tools().await.is_ok());
    assert!(tools.call("echo", json!({ "say": "hi" })).await.is_ok());
    assert!(tools.tools().await.is_ok());
    let requests = fake.request_headers();
    assert!(requests.len() >= 4, "{} requests", requests.len());
    for headers in requests {
        assert_eq!(
            headers
                .get("x-ace-notifications")
                .map(|v| v.as_bytes().to_vec()),
            Some(b"stream".to_vec()),
            "{headers:?}"
        );
        assert!(!headers.contains_key("x-ace-tools"));
        assert!(!headers.contains_key("x-ace-client"));
    }
}

#[tokio::test]
async fn a_call_returns_text_and_images_and_tool_errors_are_results() {
    let fake = FakeMcp::start(usual_tools()).await;
    let tools = client(&fake, TOKEN, Duration::from_secs(5));

    let echo = tools.call("echo", json!({ "say": "hi" })).await;
    let echo = echo.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(echo.parts, vec![Part::text("hi")]);
    assert!(!echo.is_error);

    let snap = tools.call("snap", serde_json::Value::Null).await;
    let snap = snap.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        snap.parts,
        vec![
            Part::text("here it is"),
            Part::Image {
                mime_type: "image/png".into(),
                data: PIXEL.into(),
                extra: Map::new(),
            }
        ]
    );

    let fail = tools.call("fail", json!({})).await;
    let fail = fail.unwrap_or_else(|e| panic!("{e}"));
    assert!(fail.is_error);
    assert_eq!(fail.parts, vec![Part::text("the thread is archived")]);
}

#[tokio::test]
async fn a_tool_answer_keeps_fields_spade_does_not_read() {
    let fake = FakeMcp::start(vec![tool("decorated", None, None)]).await;
    let tools = client(&fake, TOKEN, Duration::from_secs(5));
    let answer = tools.call("decorated", json!({})).await;
    let answer = answer.unwrap_or_else(|e| panic!("{e}"));
    let mut extra = Map::new();
    extra.insert("tone".into(), json!("calm"));
    assert_eq!(
        answer.parts,
        vec![Part::Text {
            text: "decorated".into(),
            extra
        }]
    );
    assert_eq!(answer.extra.get("x-ace-lane"), Some(&json!({ "lane": 2 })));
    assert_eq!(answer.extra.get("_meta"), Some(&json!({ "trace": "t-1" })));
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
    assert_eq!(fake.tool_call_frames(), 1);
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
async fn after_a_daemon_restart_tools_lists_the_new_daemons_tools() {
    let mut fake = FakeMcp::start(usual_tools()).await;
    let tools = client(&fake, TOKEN, Duration::from_secs(5));
    assert_eq!(tools.tools().await.map(|t| t.len()), Ok(5));

    fake.restart_with(vec![tool("echo", None, None), tool("notify", None, None)])
        .await;

    let after = tools.tools().await.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(names(&after), vec!["echo", "notify"]);
    let echo = tools.call("echo", json!({ "say": "two" })).await;
    assert_eq!(echo.map(|r| r.parts), Ok(vec![Part::text("two")]));
}

#[tokio::test]
async fn a_call_on_an_expired_session_is_not_run_and_not_sent_again() {
    let fake = FakeMcp::start(usual_tools()).await;
    let tools = client(&fake, TOKEN, Duration::from_secs(5));
    assert!(tools.tools().await.is_ok());

    fake.expire_sessions().await;

    let call = tools.call("echo", json!({ "say": "once" })).await;
    assert!(
        matches!(call, Err(ToolsError::NotRun(_))),
        "expected not run, got {call:?}"
    );
    assert_eq!(fake.tool_call_frames(), 1);
    assert_eq!(fake.tool_runs(), 0);

    // The next call opens a new session and runs.
    let again = tools.call("echo", json!({ "say": "now" })).await;
    assert_eq!(again.map(|r| r.parts), Ok(vec![Part::text("now")]));
    assert_eq!(fake.tool_call_frames(), 2);
    assert_eq!(fake.tool_runs(), 1);
}

#[tokio::test]
async fn a_session_replaced_by_newer_ones_on_the_same_bearer_recovers() {
    let fake = FakeMcp::start(usual_tools()).await;
    let first = client(&fake, TOKEN, Duration::from_secs(5));
    assert_eq!(first.tools().await.map(|t| t.len()), Ok(5));
    // Four more sessions on the same bearer push the first one out.
    let others: Vec<AceTools> = (0..4)
        .map(|_| client(&fake, TOKEN, Duration::from_secs(5)))
        .collect();
    for other in &others {
        assert!(other.tools().await.is_ok());
    }

    assert_eq!(first.tools().await.map(|t| t.len()), Ok(5));
    let echo = first.call("echo", json!({ "say": "back" })).await;
    assert_eq!(echo.map(|r| r.parts), Ok(vec![Part::text("back")]));
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
    assert_eq!(echo.map(|r| r.parts), Ok(vec![Part::text("still here")]));
}

#[tokio::test]
async fn nothing_listening_means_a_call_did_not_run() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("{e}"));
    let addr = listener.local_addr().unwrap_or_else(|e| panic!("{e}"));
    drop(listener);
    let tools = AceTools::new(config(
        &format!("http://{addr}/mcp"),
        TOKEN,
        Duration::from_secs(5),
    ));
    match tools.tools().await {
        Err(ToolsError::Unavailable(text)) => assert!(!text.contains(TOKEN)),
        other => panic!("expected unavailable, got {other:?}"),
    }
    assert!(matches!(
        tools.call("echo", json!({})).await,
        Err(ToolsError::NotRun(_))
    ));
}

#[tokio::test]
async fn a_non_loopback_url_never_becomes_a_tools_config() {
    for url in ["http://example.com/mcp", "http://192.168.1.4:4400/mcp"] {
        assert!(LoopbackUrl::parse(url).is_err(), "{url}");
    }
    let ws = LoopbackUrl::parse("ws://127.0.0.1:4300/").unwrap_or_else(|e| panic!("{e}"));
    assert!(ToolsConfig::new(ws, Secret::new(TOKEN), Duration::from_secs(1)).is_err());
}
