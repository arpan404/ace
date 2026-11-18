//! Spade's classifier and a repository's own configuration (ADR 0172, amendments 2 and 3), with the
//! real shell tool, a real workspace and real git. A read is not settled when the repository's
//! config names a program git runs for it (here `core.fsmonitor`); in a repository whose config
//! runs nothing it settles; and a settled read runs with Spade's overrides, so a config swapped in
//! after the decision (a file replaced, or a symlink pointed elsewhere) never runs its program. A
//! process test because what is under test is git reading the config on disk at launch.

#![cfg(unix)]

mod support;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use serde_json::{Value, json};
use spade_server::tools::{EngineHandle, Tool};
use spade_server::workspace::shell::{Confine, Confined, Confinement, Kind, Shell};
use spade_server::workspace::{Workspaces, workspace_tools};
use spade_testkit::Script;
use support::{Options, Result, Spade};

const REFUSE: &str = r#"{"verdict":"refuse","reason":"Not needed for the task."}"#;
const APPROVE: &str = r#"{"verdict":"approve","reason":"It serves the task."}"#;
const TITLE: &str = r#"{"title":"Status"}"#;

struct Setup {
    spade: Spade,
    workspaces: Workspaces,
    _dir: tempfile::TempDir,
}

/// A read-only sandbox is available, and confines each command to a pass-through (no kernel
/// sandbox in this harness). The real containment is `spade-sandbox/tests/read_only.rs`.
struct ReadOnlyHere;

impl Confine for ReadOnlyHere {
    fn confine(&self, _home: &Path, _kind: &Kind) -> std::result::Result<Confinement, String> {
        Ok(Confinement::None)
    }
    fn contains(&self, _home: &Path) -> bool {
        false
    }
    fn read_only_available(&self) -> bool {
        true
    }
    fn read_only(&self, _home: &Path, _command: &str) -> std::result::Result<Confined, String> {
        Ok(Confined {
            launch: Box::new(|program: &Path, args: &[std::ffi::OsString]| {
                Ok(spade_sandbox::Launch {
                    program: program.to_path_buf(),
                    args: args.to_vec(),
                    seals_env: false,
                })
            }),
            env: Vec::new(),
            path_first: Vec::new(),
            hold: Box::new(()),
            watch: None,
            offline: false,
        })
    }
}

async fn start(scripts: Vec<Script>) -> Result<Setup> {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path().join("workspace"));
    let bots = EngineHandle::default();
    let shell = Shell::system().confined(Arc::new(ReadOnlyHere));
    let tools: Vec<Arc<dyn Tool>> = workspace_tools(workspaces.clone(), bots.clone(), shell);
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
        Script::reply("").call("c1", "shell", json!({ "command": "git ls-files" })),
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
        Script::reply("").call("c1", "shell", json!({ "command": "git ls-files" })),
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

/// A monitor that only leaves a marker, and a copy of the repository's config that names it.
fn evil_config(root: &Path) -> Result<std::path::PathBuf> {
    let marker = root.join("monitor-ran");
    let monitor = root.join("monitor.sh");
    std::fs::write(
        &monitor,
        format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display()),
    )?;
    std::fs::set_permissions(&monitor, std::fs::Permissions::from_mode(0o755))?;
    let evil = root.join(".git/evil.cfg");
    std::fs::copy(root.join(".git/config"), &evil)?;
    git(
        root,
        &[
            "config",
            "-f",
            ".git/evil.cfg",
            "core.fsmonitor",
            &monitor.display().to_string(),
        ],
    )?;
    Ok(marker)
}

/// Decides a settled read while the config is clean, then swaps the config with `swap` (run as a
/// reviewed script) before the read launches: the marker must never appear.
async fn swapped_after_the_decision(swap: &str, symlinked: bool) -> Result {
    let setup = start(vec![
        Script::reply("")
            .call("c1", "shell", json!({ "command": "sh swap.sh" }))
            .call(
                "c2",
                "shell",
                json!({ "command": "sleep 1 && git ls-files" }),
            ),
        Script::reply("").plain(APPROVE),
        Script::reply("Done."),
        Script::reply("").plain(TITLE),
    ])
    .await?;
    let (agent, conversation) = bot(&setup.spade).await?;
    let root = setup.workspaces.of(&agent)?.path()?;
    repository(&root)?;
    let marker = evil_config(&root)?;
    if symlinked {
        std::fs::rename(root.join(".git/config"), root.join(".git/clean.cfg"))?;
        std::os::unix::fs::symlink("clean.cfg", root.join(".git/config"))?;
    }
    std::fs::write(root.join("swap.sh"), swap)?;
    // Without Spade's overrides, git would run the monitor once the config is swapped.
    setup.spade.say(&conversation, "Swap, then list").await?;
    let events = setup
        .spade
        .wait_for(&conversation, "reply_finished")
        .await?;
    let read = verdict(&events, "c2").ok_or("no verdict for the read")?;
    assert!(
        by_classifier(read),
        "the classifier settled the read: {read}"
    );
    let ran = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "c2")
        .ok_or("the read never ran")?;
    assert_eq!(ran["is_error"], false, "{ran}");
    let swapped = std::fs::read_to_string(root.join(".git/config"))?;
    assert!(
        swapped.contains("fsmonitor"),
        "the swap happened before the read"
    );
    assert!(!marker.exists(), "git ran the swapped-in monitor");
    Ok(())
}

#[tokio::test]
async fn a_settled_read_ignores_a_config_file_replaced_after_the_decision() -> Result {
    swapped_after_the_decision("cp .git/evil.cfg .git/config\n", false).await
}

#[tokio::test]
async fn a_settled_read_ignores_a_symlinked_config_pointed_elsewhere_after_the_decision() -> Result
{
    swapped_after_the_decision("ln -sf evil.cfg .git/config\n", true).await
}
