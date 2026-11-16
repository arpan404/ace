//! The stdio transport against a small real server: `fake_stdio_server.sh` under `/bin/sh`.
#![cfg(unix)]

use std::path::PathBuf;
use std::time::Duration;

use serde_json::json;
use spade_mcp::{McpClient, McpConfig, Part, Risk, StdioCommand, ToolsError};

fn command(idle: Duration) -> StdioCommand {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut command = StdioCommand::new("/bin/sh", std::env::temp_dir());
    command.args = vec![
        dir.join("fake_stdio_server.sh")
            .to_string_lossy()
            .into_owned(),
    ];
    command.env = vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("PLUGIN_MODE".into(), "local".into()),
    ];
    command.idle = idle;
    command
}

fn client(idle: Duration) -> McpClient {
    McpClient::new(McpConfig::stdio(
        "fake",
        command(idle),
        Duration::from_secs(10),
    ))
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

fn alive(pid: &str) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[tokio::test]
async fn a_local_server_lists_its_tools_answers_a_call_and_gets_none_of_spades_environment() {
    let server = client(Duration::from_secs(600));
    let tools = server.tools().await.unwrap_or_else(|e| panic!("{e}"));
    let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
    assert_eq!(names, ["env", "crash", "spawn"]);
    assert_eq!(tools[0].risk, Risk::Read);
    assert_eq!(tools[1].risk, Risk::Write, "unlabelled means write");
    let answer = server.call("env", json!({})).await;
    let env = text(&answer.unwrap_or_else(|e| panic!("{e}")));
    // Exactly what it was given, plus what `sh` sets itself: nothing of Spade's environment,
    // which carries its secrets.
    let names: Vec<&str> = env
        .split_whitespace()
        .filter_map(|pair| pair.split_once('=').map(|(name, _)| name))
        .collect();
    assert_eq!(names, ["PATH", "PLUGIN_MODE", "PWD", "SHLVL", "_"], "{env}");
    assert!(env.contains("PLUGIN_MODE=local"), "{env}");
}

#[tokio::test]
async fn closing_a_local_server_ends_what_it_started_too() {
    let server = client(Duration::from_secs(600));
    let answer = server.call("spawn", json!({})).await;
    let pid = text(&answer.unwrap_or_else(|e| panic!("{e}")));
    assert!(alive(&pid));
    server.close();
    let mut gone = false;
    for _ in 0..50 {
        if !alive(&pid) {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(gone, "the server's own child {pid} outlived it");
}

#[tokio::test]
async fn an_idle_server_is_stopped_and_started_again_on_the_next_use_without_counting_a_crash() {
    let server = client(Duration::from_millis(300));
    server
        .call("env", json!({}))
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    let first = server.process_id();
    assert!(first.is_some());
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(
        server.process_id(),
        None,
        "still running after its idle time"
    );
    // Idle stops never use up the restart budget.
    for _ in 0..5 {
        server
            .call("env", json!({}))
            .await
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(server.process_id().is_some());
        tokio::time::sleep(Duration::from_millis(900)).await;
    }
    assert!(!server.gave_up());
}

#[tokio::test]
async fn a_crashed_server_restarts_three_times_then_says_it_failed() {
    let server = client(Duration::from_secs(600));
    for restart in 0..4 {
        let crashed = server.call("crash", json!({})).await;
        assert!(crashed.is_err(), "crash {restart} answered");
        if restart < 3 {
            let after = server.call("env", json!({})).await;
            assert!(after.is_ok(), "restart {restart}: {after:?}");
        }
    }
    let refused = server.call("env", json!({})).await;
    match refused {
        Err(ToolsError::NotRun(why) | ToolsError::Unavailable(why)) => {
            assert!(why.contains("turned off and on"), "{why}");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(server.gave_up());
    assert_eq!(server.process_id(), None);
}
