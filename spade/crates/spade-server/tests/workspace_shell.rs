//! The workspace shell with real child processes (ADR 0130): what asks and what runs at once,
//! the deadline that kills the whole process group, the clean environment, and large output kept
//! as a file. Process tests: each starts real shells.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_server::tools::{EngineHandle, Tool};
use spade_server::workspace::shell::Shell;
use spade_server::workspace::{Workspaces, workspace_tools};
use spade_testkit::Script;
use support::{Result, Spade, types};

async fn start(scripts: Vec<Script>, workspaces: &Workspaces) -> Result<Spade> {
    let bots = EngineHandle::default();
    let tools: Vec<Arc<dyn Tool>> =
        workspace_tools(workspaces.clone(), bots.clone(), Shell::system());
    let spade = Spade::start(scripts, tools).await?;
    bots.set(&spade.engine);
    Ok(spade)
}

async fn bot(spade: &Spade) -> Result<(String, String)> {
    let agent = spade.new_agent("Runner", "").await?;
    let field = |name: &str| agent[name].as_str().unwrap_or_default().to_owned();
    Ok((field("id"), field("conversation")))
}

fn finished<'a>(events: &'a [Value], call: &str) -> Option<&'a Value> {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
}

#[cfg(unix)]
#[tokio::test]
async fn a_read_only_command_runs_at_once_and_any_other_asks_first() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let spade = start(
        vec![
            Script::reply("").call("c1", "shell", json!({ "command": "ls -a" })),
            Script::reply("").call("c2", "shell", json!({ "command": "touch made.txt" })),
            Script::reply("Okay, I won't."),
        ],
        &workspaces,
    )
    .await?;
    let (bot_id, conversation) = bot(&spade).await?;
    spade.say(&conversation, "Look, then make a file").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    let asked: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .collect();
    assert_eq!(asked.len(), 1);
    assert_eq!(
        asked[0]["call_id"], "c2",
        "only the command that writes asks"
    );
    let listed = finished(&events, "c1").ok_or("ls never ran")?;
    assert_eq!(listed["is_error"], false, "{listed}");

    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/c2"),
            json!({ "allowed": false }),
        )
        .await?;
    assert_eq!(status, 202);
    spade.wait_for(&conversation, "reply_finished").await?;
    let root = workspaces.of(&bot_id)?.root()?;
    assert!(
        !root.join("made.txt").exists(),
        "a declined command never runs"
    );
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn allowing_a_command_always_lets_the_bots_later_commands_run() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let spade = start(
        vec![
            Script::reply("").call("c1", "shell", json!({ "command": "touch one.txt" })),
            Script::reply("").call("c2", "shell", json!({ "command": "touch two.txt" })),
            Script::reply("Both made."),
        ],
        &workspaces,
    )
    .await?;
    let (bot_id, conversation) = bot(&spade).await?;
    spade.say(&conversation, "Make two files").await?;
    spade.wait_for(&conversation, "approval_requested").await?;
    spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/c1"),
            json!({ "allowed": true, "always": true }),
        )
        .await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let asks = events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .count();
    assert_eq!(asks, 1, "{:?}", types(&events));
    let root = workspaces.of(&bot_id)?.root()?;
    assert!(root.join("one.txt").exists() && root.join("two.txt").exists());
    Ok(())
}

/// Whether process `pid` is still running (a zombie waiting to be reaped counts as gone).
#[cfg(unix)]
fn alive(pid: &str) -> bool {
    std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", pid])
        .output()
        .map(|out| {
            let stat = String::from_utf8_lossy(&out.stdout);
            out.status.success() && !stat.trim().is_empty() && !stat.trim().starts_with('Z')
        })
        .unwrap_or(false)
}

#[cfg(unix)]
#[tokio::test]
async fn a_command_past_its_deadline_is_killed_with_everything_it_started() -> Result {
    let dir = tempfile::tempdir()?;
    let started = Instant::now();
    let ran = Shell::system()
        .run(
            dir.path(),
            "sleep 30 & echo $! > child.pid; sleep 30",
            Duration::from_secs(1),
        )
        .await?;
    assert!(ran.timed_out);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    let child = std::fs::read_to_string(dir.path().join("child.pid"))?;
    let child = child.trim();
    assert!(!child.is_empty());
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(child) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        !alive(child),
        "the background child {child} outlived its group"
    );
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn a_finished_command_leaves_nothing_running_in_the_background() -> Result {
    let dir = tempfile::tempdir()?;
    let ran = Shell::system()
        .run(
            dir.path(),
            "sleep 30 > /dev/null 2>&1 & echo $! > child.pid",
            Duration::from_secs(5),
        )
        .await?;
    assert!(!ran.timed_out);
    let child = std::fs::read_to_string(dir.path().join("child.pid"))?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(child.trim()) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!alive(child.trim()));
    Ok(())
}

#[tokio::test]
async fn the_shell_environment_carries_none_of_spades_secrets() -> Result {
    let dir = tempfile::tempdir()?;
    // Spade's own environment as the shell would see it: its token, keys and ace's grant.
    let spade_env: spade_server::workspace::shell::Env = Arc::new(|name: &str| match name {
        "PATH" => std::env::var("PATH").ok(),
        "SPADE_TOKEN"
        | "SPADE_ACE_TOKEN"
        | "SPADE_ACE_MCP_TOKEN"
        | "OPENAI_API_KEY"
        | "ANTHROPIC_API_KEY" => Some("secret-value-1234".to_owned()),
        _ => None,
    });
    let command = if cfg!(windows) { "set" } else { "env" };
    let ran = Shell::new(spade_env)
        .run(dir.path(), command, Duration::from_secs(10))
        .await?;
    assert_eq!(ran.code, Some(0), "{ran:?}");
    assert!(!ran.stdout.contains("secret-value-1234"), "{}", ran.stdout);
    for name in ["SPADE_TOKEN", "OPENAI_API_KEY", "CARGO_MANIFEST_DIR"] {
        assert!(
            !ran.stdout.contains(&format!("{name}=")),
            "{name} reached the shell"
        );
    }
    assert!(ran.stdout.contains("HOME="), "{}", ran.stdout);
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn output_too_large_for_the_model_is_kept_as_a_file_it_can_read() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path());
    let spade = start(
        vec![
            Script::reply("").call("c1", "shell", json!({ "command": "cat big.txt" })),
            Script::reply("That is long."),
        ],
        &workspaces,
    )
    .await?;
    let (bot_id, conversation) = bot(&spade).await?;
    let root = workspaces.of(&bot_id)?.root()?;
    let big: String = (0..4_000).map(|n| format!("line {n:05}\n")).collect();
    std::fs::write(root.join("big.txt"), &big)?;
    spade.say(&conversation, "Show the big file").await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let content = finished(&events, "c1")
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default()
        .to_owned();
    assert!(content.len() < big.len(), "the model got all of it");
    assert!(content.contains("line 00000") && content.contains("line 03999"));
    let kept = content
        .split_whitespace()
        .find(|word| word.starts_with(".spade/outputs/"))
        .map(|word| word.trim_end_matches(';'))
        .ok_or(format!("no path in {content}"))?;
    let stored = std::fs::read_to_string(root.join(kept))?;
    assert!(stored.contains(&big), "the file holds the whole output");
    Ok(())
}
