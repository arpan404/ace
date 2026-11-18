//! Spade's classifier and a repository's own configuration (ADR 0172, amendment 2), with the real
//! shell tool, a real workspace and real git: a read the classifier would settle is not settled
//! when the repository's config names a program git runs for it (here `core.fsmonitor`), and the
//! program never runs before a review; in a repository whose config runs nothing the same read
//! settles. A process test because what is under test is git reading the config on disk.

#![cfg(unix)]

mod support;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use serde_json::{Value, json};
use spade_server::tools::{EngineHandle, Tool};
use spade_server::workspace::shell::Shell;
use spade_server::workspace::{Workspaces, workspace_tools};
use spade_testkit::Script;
use support::{Options, Result, Spade};

const REFUSE: &str = r#"{"verdict":"refuse","reason":"Not needed for the task."}"#;
const TITLE: &str = r#"{"title":"Status"}"#;

struct Setup {
    spade: Spade,
    workspaces: Workspaces,
    _dir: tempfile::TempDir,
}

async fn start(scripts: Vec<Script>) -> Result<Setup> {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path().join("workspace"));
    let bots = EngineHandle::default();
    let tools: Vec<Arc<dyn Tool>> =
        workspace_tools(workspaces.clone(), bots.clone(), Shell::system());
    let spade = Spade::start_with(
        scripts,
        tools,
        Options {
            workspaces: Some(workspaces.clone()),
            reviewer: None,
            classifier: true,
            ..Options::default()
        },
    )
    .await?;
    bots.set(&spade.engine);
    Ok(Setup {
        spade,
        workspaces,
        _dir: dir,
    })
}

async fn bot(spade: &Spade) -> Result<(String, String)> {
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Builder", "task": "Check the repository", "model": "fake/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let field = |name: &str| body["agent"][name].as_str().unwrap_or_default().to_owned();
    Ok((field("id"), field("conversation")))
}

fn git(root: &Path, args: &[&str]) -> Result {
    let status = Command::new("git").args(args).current_dir(root).status()?;
    if !status.success() {
        return Err(format!("git {args:?} failed").into());
    }
    Ok(())
}

/// A repository with one committed file, so `git status` has an index to refresh.
fn repository(root: &Path) -> Result {
    git(root, &["init", "-q"])?;
    std::fs::write(root.join("README.md"), "hello\n")?;
    git(root, &["add", "README.md"])?;
    git(
        root,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-qm",
            "first",
        ],
    )?;
    Ok(())
}

fn verdict<'a>(events: &'a [Value], call: &str) -> Option<&'a Value> {
    events
        .iter()
        .find(|e| e["type"] == "call_reviewed" && e["call_id"] == call)
}

fn by_classifier(verdict: &Value) -> bool {
    verdict["model"]
        .as_str()
        .is_some_and(|m| m.starts_with("spade-classify/"))
}

#[tokio::test]
async fn a_read_in_a_repository_whose_config_runs_a_program_goes_to_the_reviewer() -> Result {
    let setup = start(vec![
        Script::reply("").call("c1", "shell", json!({ "command": "git status --short" })),
        Script::reply("").plain(REFUSE),
        Script::reply("I won't run it."),
        Script::reply("").plain(TITLE),
    ])
    .await?;
    let (agent, conversation) = bot(&setup.spade).await?;
    let root = setup.workspaces.of(&agent)?.path()?;
    repository(&root)?;
    // A harmless monitor: all it does is leave a marker.
    let marker = root.join("monitor-ran");
    let monitor = root.join("monitor.sh");
    std::fs::write(
        &monitor,
        format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display()),
    )?;
    std::fs::set_permissions(&monitor, std::fs::Permissions::from_mode(0o755))?;
    git(
        &root,
        &["config", "core.fsmonitor", &monitor.display().to_string()],
    )?;
    setup
        .spade
        .say(&conversation, "Check the repository")
        .await?;
    let events = setup
        .spade
        .wait_for(&conversation, "reply_finished")
        .await?;
    let reviewed = verdict(&events, "c1").ok_or("no verdict")?;
    assert!(!by_classifier(reviewed), "the reviewer decided: {reviewed}");
    assert_eq!(reviewed["verdict"], "refuse", "{reviewed}");
    assert!(!marker.exists(), "the monitor ran before a review");
    Ok(())
}

#[tokio::test]
async fn the_same_read_in_a_repository_whose_config_runs_nothing_settles() -> Result {
    let setup = start(vec![
        Script::reply("").call("c1", "shell", json!({ "command": "git status --short" })),
        Script::reply("Clean."),
        Script::reply("").plain(TITLE),
    ])
    .await?;
    let (agent, conversation) = bot(&setup.spade).await?;
    let root = setup.workspaces.of(&agent)?.path()?;
    repository(&root)?;
    setup
        .spade
        .say(&conversation, "Check the repository")
        .await?;
    let events = setup
        .spade
        .wait_for(&conversation, "reply_finished")
        .await?;
    let reviewed = verdict(&events, "c1").ok_or("no verdict")?;
    assert!(
        by_classifier(reviewed),
        "the classifier settled it: {reviewed}"
    );
    Ok(())
}
