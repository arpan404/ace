//! The auto-review of a shell command that runs a file (ADR 0144), with the real shell tool and
//! a real workspace: the reviewer is shown the file, and an approval holds only while the file is
//! as it read it. A process test because what is under test is the file on disk as the command
//! starts; the classifier's reading of commands is unit-tested in `spade_core`.

#![cfg(unix)]

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_server::tools::{EngineHandle, Tool};
use spade_server::workspace::shell::Shell;
use spade_server::workspace::{Workspaces, workspace_tools};
use spade_testkit::Script;
use support::{Options, Result, Spade};

const APPROVE: &str = r#"{"verdict":"approve","reason":"It builds the project."}"#;

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
            // The fake reviews, in script order.
            reviewer: None,
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

/// A bot: its id and conversation.
async fn bot(spade: &Spade) -> Result<(String, String)> {
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Builder", "task": "Build the project", "model": "fake/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let field = |name: &str| body["agent"][name].as_str().unwrap_or_default().to_owned();
    Ok((field("id"), field("conversation")))
}

fn result<'a>(events: &'a [Value], call: &str) -> Option<&'a Value> {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
}

#[tokio::test]
async fn the_reviewer_reads_the_script_a_command_runs_and_an_approval_runs_it() -> Result {
    let setup = start(vec![
        Script::reply("").call("c1", "shell", json!({ "command": "sh build.sh" })),
        Script::reply("").plain(APPROVE),
        Script::reply("Built."),
        Script::reply("").plain(r#"{"title":"Build"}"#),
    ])
    .await?;
    let (agent, conversation) = bot(&setup.spade).await?;
    let root = setup.workspaces.of(&agent)?.path()?;
    std::fs::write(root.join("build.sh"), "echo built > done.txt\n")?;
    setup.spade.say(&conversation, "Build it").await?;
    let events = setup
        .spade
        .wait_for(&conversation, "reply_finished")
        .await?;
    let finished = result(&events, "c1").ok_or("no result")?;
    assert_eq!(finished["is_error"], false, "{finished}");
    assert!(root.join("done.txt").exists(), "the script ran");
    let review = setup.spade.fake.seen()[1].body.to_string();
    assert!(review.contains("echo built"), "{review}");
    Ok(())
}

#[tokio::test]
async fn a_script_changed_after_its_review_is_not_run() -> Result {
    let setup = start(vec![
        Script::reply("").call("c1", "shell", json!({ "command": "sh build.sh" })),
        // The reviewer takes a moment; the script changes meanwhile.
        Script::reply("")
            .plain(APPROVE)
            .held(Duration::from_millis(500)),
        Script::reply("It changed; I'll ask again."),
        Script::reply("").plain(r#"{"title":"Build"}"#),
    ])
    .await?;
    let (agent, conversation) = bot(&setup.spade).await?;
    let root = setup.workspaces.of(&agent)?.path()?;
    std::fs::write(root.join("build.sh"), "echo built > done.txt\n")?;
    setup.spade.say(&conversation, "Build it").await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while setup.spade.fake.seen().len() < 2 {
        if Instant::now() > deadline {
            return Err("the reviewer was never asked".into());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    std::fs::write(root.join("build.sh"), "echo changed > changed.txt\n")?;
    let events = setup
        .spade
        .wait_for(&conversation, "reply_finished")
        .await?;
    let finished = result(&events, "c1").ok_or("no result")?;
    let content = finished["content"].as_str().unwrap_or("");
    assert!(
        content.starts_with("Not run: A file it runs changed after it was reviewed."),
        "{content}"
    );
    assert!(!root.join("changed.txt").exists(), "nothing ran");
    assert!(!root.join("done.txt").exists());
    Ok(())
}

#[tokio::test]
async fn a_script_spade_cant_read_is_refused_rather_than_put_to_the_person() -> Result {
    // Outside the workspace: Spade can't read it, so nothing it is shown, and nothing an answer
    // would be held to, is what will run (ADR 0171, amendment 4).
    let outside = tempfile::tempdir()?;
    std::fs::write(outside.path().join("run.sh"), "echo hi\n")?;
    let command = format!("sh {}", outside.path().join("run.sh").display());
    let setup = start(vec![
        Script::reply("").call("c1", "shell", json!({ "command": command })),
        Script::reply("Okay."),
    ])
    .await?;
    let (_, conversation) = bot(&setup.spade).await?;
    setup.spade.say(&conversation, "Run it").await?;
    let events = setup
        .spade
        .wait_for(&conversation, "reply_finished")
        .await?;
    assert!(
        !events.iter().any(|e| e["type"] == "approval_requested"),
        "asked about it"
    );
    let said = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "c1")
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default();
    assert!(said.contains("couldn't be read whole"), "{said}");
    assert!(
        !events.iter().any(|e| e["type"] == "tool_started"),
        "it ran"
    );
    // No reviewer was paid for.
    assert!(
        !setup.spade.fake.seen().iter().any(|seen| seen
            .body
            .to_string()
            .contains("You approve or refuse one step")),
        "a reviewer was asked"
    );
    Ok(())
}
