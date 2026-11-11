//! Spade's connection to ace through the real server: the grant goes into the (mock) keychain
//! and never comes back out, ace's tools are absent while the daemon is, and they arrive once its
//! files and its MCP endpoint do.

#[path = "../../spade-ace/tests/support/fake_mcp.rs"]
#[allow(dead_code)]
mod fake_mcp;
mod support;

use std::path::Path;
use std::time::{Duration, Instant};

use fake_mcp::{FakeMcp, tool};
use serde_json::{Value, json};
use spade_server::tools::ToolSource;
use spade_testkit::Script;
use support::{Options, Result, Spade};

fn with_ace(home: &Path) -> Options {
    Options {
        ace_home: Some(home.to_path_buf()),
        ..Default::default()
    }
}

/// Writes the files a running daemon leaves in ace's home.
fn daemon_files(home: &Path, mcp: &FakeMcp) -> Result {
    let endpoint = mcp.url().trim_end_matches("/mcp").to_owned();
    std::fs::write(home.join("daemon-endpoint"), format!("{endpoint}\n"))?;
    std::fs::write(home.join("daemon-token"), "local-token\n")?;
    Ok(())
}

async fn wait_connected(spade: &Spade, connected: bool) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (_, state) = spade.get("/v1/ace").await?;
        if state["connected"] == connected {
            return Ok(state);
        }
        if Instant::now() > deadline {
            return Err(format!("never connected={connected}: {state}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn ace_tool_names(spade: &Spade) -> Vec<String> {
    spade
        .ace
        .as_ref()
        .map(|ace| ace.tools().iter().map(|t| t.def().spec.name).collect())
        .unwrap_or_default()
}

fn tool_result(events: &[Value], call: &str) -> String {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default()
        .to_owned()
}

#[tokio::test]
async fn without_the_daemon_spade_runs_without_ace_tools_and_they_arrive_with_it() -> Result {
    let home = tempfile::tempdir()?;
    let echo = json!({ "name": "echo", "arguments": { "say": "hi from ace" } });
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("c1", "call_tool", echo.clone()),
            Script::reply("ace is away."),
            Script::reply("").plain(r#"{"title":"Echo"}"#),
            Script::reply("").call("c2", "call_tool", echo),
            Script::reply("ace said hi."),
        ],
        Vec::new(),
        with_ace(home.path()),
    )
    .await?;
    let (status, _) = spade
        .put("/v1/ace", json!({ "grant": fake_mcp::TOKEN }))
        .await?;
    assert_eq!(status, 204);

    // No daemon-endpoint yet: chat works, ace's tools are simply not there.
    let id = spade.ask("Say hi through ace").await?;
    let events = spade.wait_for(&id, "reply_finished").await?;
    assert!(
        tool_result(&events, "c1").contains("no tool named echo"),
        "{}",
        tool_result(&events, "c1")
    );
    assert_eq!(
        spade.get("/v1/ace").await?.1,
        json!({ "grant": true, "connected": false })
    );
    assert!(ace_tool_names(&spade).is_empty());

    let mcp = FakeMcp::start(vec![tool("echo", Some(true), None)]).await;
    daemon_files(home.path(), &mcp)?;
    wait_connected(&spade, true).await?;
    assert_eq!(ace_tool_names(&spade), vec!["echo".to_owned()]);

    spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "Try again" }),
        )
        .await?;
    let events = spade.wait_for_count(&id, "reply_finished", 2).await?;
    assert_eq!(tool_result(&events, "c2"), "hi from ace");
    Ok(())
}

#[tokio::test]
async fn the_grant_is_kept_in_the_keychain_and_never_returned() -> Result {
    let home = tempfile::tempdir()?;
    let mcp = FakeMcp::start(vec![tool("echo", Some(true), None)]).await;
    daemon_files(home.path(), &mcp)?;
    let spade = Spade::start_with(Vec::new(), Vec::new(), with_ace(home.path())).await?;
    assert_eq!(
        spade.get("/v1/ace").await?.1,
        json!({ "grant": false, "connected": false })
    );

    spade
        .put("/v1/ace", json!({ "grant": fake_mcp::TOKEN }))
        .await?;
    assert_eq!(spade.keys.ace_grant()?.as_deref(), Some(fake_mcp::TOKEN));
    let state = wait_connected(&spade, true).await?;
    assert_eq!(state, json!({ "grant": true, "connected": true }));
    assert!(!state.to_string().contains(fake_mcp::TOKEN));

    let (status, _) = spade.delete("/v1/ace").await?;
    assert_eq!(status, 204);
    assert_eq!(spade.keys.ace_grant()?, None);
    assert_eq!(
        spade.get("/v1/ace").await?.1,
        json!({ "grant": false, "connected": false })
    );
    assert!(ace_tool_names(&spade).is_empty(), "forgetting disconnects");
    Ok(())
}

#[tokio::test]
async fn a_refused_grant_keeps_retrying_and_a_new_grant_connects_at_once() -> Result {
    let home = tempfile::tempdir()?;
    let mcp = FakeMcp::start(vec![tool("echo", Some(true), None)]).await;
    daemon_files(home.path(), &mcp)?;
    let spade = Spade::start_with(Vec::new(), Vec::new(), with_ace(home.path())).await?;
    spade
        .put("/v1/ace", json!({ "grant": "revoked-grant" }))
        .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(spade.get("/v1/ace").await?.1["connected"], false);

    spade
        .put("/v1/ace", json!({ "grant": fake_mcp::TOKEN }))
        .await?;
    wait_connected(&spade, true).await?;
    let (status, _) = spade.put("/v1/ace", json!({ "grant": "  " })).await?;
    assert_eq!(status, 400);
    Ok(())
}

#[tokio::test]
async fn when_the_daemon_goes_away_its_tools_go_and_come_back_with_it() -> Result {
    let home = tempfile::tempdir()?;
    let mut mcp = FakeMcp::start(vec![tool("echo", Some(true), None)]).await;
    daemon_files(home.path(), &mcp)?;
    let spade = Spade::start_with(Vec::new(), Vec::new(), with_ace(home.path())).await?;
    spade
        .put("/v1/ace", json!({ "grant": fake_mcp::TOKEN }))
        .await?;
    wait_connected(&spade, true).await?;

    // A daemon restart that changes what it offers.
    mcp.restart_with(vec![tool("snap", Some(true), None)]).await;
    let deadline = Instant::now() + Duration::from_secs(15);
    while ace_tool_names(&spade) != vec!["snap".to_owned()] {
        assert!(Instant::now() < deadline, "{:?}", ace_tool_names(&spade));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    drop(mcp);
    let deadline = Instant::now() + Duration::from_secs(15);
    while !ace_tool_names(&spade).is_empty() {
        assert!(
            Instant::now() < deadline,
            "tools stayed after the daemon left"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(spade.get("/v1/ace").await?.1["connected"], false);
    Ok(())
}

#[tokio::test]
async fn after_the_grant_is_forgotten_a_tool_kept_from_before_sends_nothing() -> Result {
    let home = tempfile::tempdir()?;
    let mcp = FakeMcp::start(vec![tool("echo", Some(true), None)]).await;
    daemon_files(home.path(), &mcp)?;
    let spade = Spade::start_with(Vec::new(), Vec::new(), with_ace(home.path())).await?;
    spade
        .put("/v1/ace", json!({ "grant": fake_mcp::TOKEN }))
        .await?;
    wait_connected(&spade, true).await?;
    // A running turn holds on to the tool it looked up.
    let kept = spade
        .ace
        .as_ref()
        .and_then(|ace| ace.tools().into_iter().next())
        .ok_or("no ace tool")?;

    let (status, _) = spade.delete("/v1/ace").await?;
    assert_eq!(status, 204);
    let output = kept.run("c_1.call_1", json!({ "say": "late" })).await;
    assert!(
        output.is_error && output.content.starts_with("Not run"),
        "{output:?}"
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        mcp.tool_call_frames(),
        0,
        "nothing went out with the forgotten grant"
    );
    Ok(())
}

#[tokio::test]
async fn a_daemon_that_stops_answering_loses_its_tools_within_the_check() -> Result {
    let home = tempfile::tempdir()?;
    let mcp = FakeMcp::start(vec![tool("echo", Some(true), None)]).await;
    daemon_files(home.path(), &mcp)?;
    let spade = Spade::start_with(Vec::new(), Vec::new(), with_ace(home.path())).await?;
    spade
        .put("/v1/ace", json!({ "grant": fake_mcp::TOKEN }))
        .await?;
    wait_connected(&spade, true).await?;

    mcp.hang();
    let started = Instant::now();
    wait_connected(&spade, false).await?;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert!(ace_tool_names(&spade).is_empty());
    Ok(())
}

#[tokio::test]
async fn after_a_connection_worked_the_backoff_starts_over() -> Result {
    let home = tempfile::tempdir()?;
    let spade = Spade::start_with(
        Vec::new(),
        Vec::new(),
        Options {
            ace_home: Some(home.path().to_path_buf()),
            ace_retry: Some(spade_server::tools::Retry {
                first: Duration::from_millis(20),
                longest: Duration::from_millis(1500),
                check: Duration::from_millis(50),
                answer: Duration::from_millis(300),
            }),
            ..Default::default()
        },
    )
    .await?;
    spade
        .put("/v1/ace", json!({ "grant": fake_mcp::TOKEN }))
        .await?;
    // No daemon for long enough that the wait grows to its longest.
    tokio::time::sleep(Duration::from_millis(2800)).await;
    let mcp = FakeMcp::start(vec![tool("echo", Some(true), None)]).await;
    daemon_files(home.path(), &mcp)?;
    wait_connected(&spade, true).await?;

    drop(mcp);
    wait_connected(&spade, false).await?;
    let back = FakeMcp::start(vec![tool("echo", Some(true), None)]).await;
    daemon_files(home.path(), &back)?;
    let started = Instant::now();
    wait_connected(&spade, true).await?;
    assert!(
        started.elapsed() < Duration::from_millis(700),
        "reconnected after {:?}",
        started.elapsed()
    );
    Ok(())
}
