//! A bot that delegates to ace's agents reads as working until ace says the children settled,
//! however long they take and across a restart (AGENTS.md priority 1), against a stand-in for
//! ace's MCP endpoint whose `wait` times out until the test lets the children finish.

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

async fn connect(spade: &Spade, home: &Path, mcp: &FakeMcp) -> Result {
    let endpoint = mcp.url().trim_end_matches("/mcp").to_owned();
    std::fs::write(home.join("daemon-endpoint"), format!("{endpoint}\n"))?;
    std::fs::write(home.join("daemon-token"), "local-token\n")?;
    spade
        .put("/v1/ace", json!({ "grant": fake_mcp::TOKEN }))
        .await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while spade.ace.as_ref().is_none_or(|ace| ace.tools().len() < 2) {
        if Instant::now() > deadline {
            return Err("ace's tools never arrived".into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

async fn state(spade: &Spade, conversation: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["conversation"] == conversation))
        .map(|a| a["state"].clone())
        .unwrap_or_default())
}

fn delegating() -> Vec<Script> {
    vec![
        Script::reply("").call(
            "c1",
            "call_tool",
            json!({ "name": "delegate",
                    "arguments": { "tasks": [{ "task": "Fix the bug", "role": "Fix-bug" }] } }),
        ),
        Script::reply("I handed the fix to an agent."),
        Script::reply("").plain(r#"{"title":"Bug"}"#),
    ]
}

/// Asks the bot to delegate, approves it, and waits for the reply that handed it off.
async fn delegate(spade: &Spade) -> Result<String> {
    let id = spade.ask("Get the bug fixed").await?;
    spade.wait_for(&id, "approval_requested").await?;
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{id}/approvals/c1"),
            json!({ "allowed": true }),
        )
        .await?;
    assert_eq!(status, 202);
    spade.wait_for(&id, "reply_finished").await?;
    Ok(id)
}

fn job_result(events: &[Value]) -> Option<String> {
    events
        .iter()
        .find(|e| e["type"] == "job_finished" && e["job"] == "c1")
        .and_then(|e| e["content"].as_str().map(str::to_owned))
}

#[tokio::test]
async fn a_bot_reads_as_working_until_the_children_it_delegated_to_settle() -> Result {
    let home = tempfile::tempdir()?;
    let mcp = FakeMcp::start(vec![
        tool("delegate", Some(false), None),
        tool("wait", Some(true), None),
    ])
    .await;
    let mut scripts = delegating();
    scripts.push(Script::reply("The agent fixed the bug."));
    let spade = Spade::start_with(scripts, Vec::new(), with_ace(home.path())).await?;
    connect(&spade, home.path(), &mcp).await?;
    let id = delegate(&spade).await?;

    // ace's waits run out again and again; the children still work, so the bot does too.
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let events = spade.events(&id).await?;
    assert_eq!(
        job_result(&events),
        None,
        "the job ended while the children ran"
    );
    assert_eq!(state(&spade, &id).await?, "working");
    assert!(mcp.tool_runs() >= 2, "it waited again: {}", mcp.tool_runs());

    mcp.settle_children();
    let events = spade.wait_for(&id, "job_finished").await?;
    let result = job_result(&events).unwrap_or_default();
    assert!(
        result.contains("Fixed the bug.") && result.contains("\"ready\"") && result.contains("t1"),
        "{result}"
    );
    spade.wait_for_count(&id, "reply_finished", 2).await?;
    Ok(())
}

#[tokio::test]
async fn after_a_restart_the_delegate_job_reattaches_to_its_children() -> Result {
    let home = tempfile::tempdir()?;
    let mcp = FakeMcp::start(vec![
        tool("delegate", Some(false), None),
        tool("wait", Some(true), None),
    ])
    .await;
    let spade = Spade::start_with(delegating(), Vec::new(), with_ace(home.path())).await?;
    connect(&spade, home.path(), &mcp).await?;
    let id = delegate(&spade).await?;

    // The old process's job ends with it, storing nothing.
    spade.engine.drop_jobs_as_on_exit();
    let spade = spade
        .restart_after_stop_with(
            Duration::from_secs(1),
            Vec::new(),
            vec![Script::reply("The agent fixed the bug.")],
            with_ace(home.path()),
        )
        .await?;
    connect(&spade, home.path(), &mcp).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let events = spade.events(&id).await?;
    assert_eq!(
        job_result(&events),
        None,
        "not lost: still waiting on its child"
    );
    assert_eq!(state(&spade, &id).await?, "working");

    mcp.settle_children();
    let events = spade.wait_for(&id, "job_finished").await?;
    let result = job_result(&events).unwrap_or_default();
    assert!(result.contains("Fixed the bug."), "{result}");
    spade.wait_for_count(&id, "reply_finished", 2).await?;
    Ok(())
}
