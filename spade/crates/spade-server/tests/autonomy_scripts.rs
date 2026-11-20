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

/// Allows the request for `call` once.
async fn allow(spade: &Spade, conversation: &str, call: &str) -> Result {
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/{call}"),
            json!({ "allowed": true }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    Ok(())
}

fn asked<'a>(events: &'a [Value], call: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|e| e["type"] == "approval_requested" && e["call_id"] == call)
        .collect()
}

#[tokio::test]
async fn a_script_changed_after_its_review_is_put_to_the_person_as_it_is_now() -> Result {
    let setup = start(vec![
        Script::reply("").call("c1", "shell", json!({ "command": "sh build.sh" })),
        // The reviewer takes a moment; the script changes meanwhile.
        Script::reply("")
            .plain(APPROVE)
            .held(Duration::from_millis(500)),
        Script::reply("Ran it as it is now."),
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
        .wait_for(&conversation, "approval_requested")
        .await?;
    // The reviewer's approval of the old script never runs: the person is asked on the new one.
    let request = asked(&events, "c1");
    let request = request.first().ok_or("not asked")?;
    assert_eq!(
        request["reviewer_reason"],
        spade_core::autonomy::escalate::CHANGED_AT_LAUNCH
    );
    assert_eq!(request["stopped"], "changed");
    assert!(result(&events, "c1").is_none(), "the bot was told no");
    assert!(!root.join("changed.txt").exists(), "nothing ran");
    assert!(!root.join("done.txt").exists());
    allow(&setup.spade, &conversation, "c1").await?;
    let events = setup
        .spade
        .wait_for(&conversation, "reply_finished")
        .await?;
    let finished = result(&events, "c1").ok_or("no result")?;
    assert_eq!(finished["is_error"], false, "{finished}");
    assert!(
        root.join("changed.txt").exists(),
        "what the person allowed ran"
    );
    assert!(!root.join("done.txt").exists(), "the old script never ran");
    assert_eq!(asked(&events, "c1").len(), 1);
    Ok(())
}

#[tokio::test]
async fn a_script_spade_cant_read_whole_is_put_to_the_person_and_runs_once_on_their_allow() -> Result
{
    // Outside the workspace: Spade can't read it whole, so neither the rules nor a reviewer can
    // vouch for it there; the person decides (ADR 0163, amendment 3).
    let outside = tempfile::tempdir()?;
    let mark = outside.path().join("ran.txt");
    std::fs::write(
        outside.path().join("run.sh"),
        format!("echo hi >> {}\n", mark.display()),
    )?;
    let command = format!("sh {}", outside.path().join("run.sh").display());
    let setup = start(vec![
        Script::reply("").call("c1", "shell", json!({ "command": command })),
        Script::reply("Ran it."),
        Script::reply("").plain(r#"{"title":"Run"}"#),
    ])
    .await?;
    let (_, conversation) = bot(&setup.spade).await?;
    setup.spade.say(&conversation, "Run it").await?;
    let events = setup
        .spade
        .wait_for(&conversation, "approval_requested")
        .await?;
    let request = asked(&events, "c1");
    let request = request.first().ok_or("not asked")?;
    let reason = request["reviewer_reason"].as_str().unwrap_or_default();
    assert!(reason.contains("couldn't be read whole"), "{reason}");
    assert_eq!(request["stopped"], "incomplete");
    assert!(
        !events.iter().any(|e| e["type"] == "tool_started"),
        "it ran"
    );
    // No reviewer was paid for: it can't read the call whole either.
    assert!(
        !setup.spade.fake.seen().iter().any(|seen| seen
            .body
            .to_string()
            .contains("You approve or refuse one step")),
        "a reviewer was asked"
    );
    allow(&setup.spade, &conversation, "c1").await?;
    let events = setup
        .spade
        .wait_for(&conversation, "reply_finished")
        .await?;
    let finished = result(&events, "c1").ok_or("no result")?;
    assert_eq!(finished["is_error"], false, "{finished}");
    assert_eq!(std::fs::read_to_string(&mark)?, "hi\n", "ran exactly once");
    Ok(())
}
