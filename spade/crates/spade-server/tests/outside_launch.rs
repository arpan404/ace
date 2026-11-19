//! The one way a bot's command starts outside the sandbox (ADR 0171, amendment 5), through the
//! server: what the gate reads finds every executable whatever the command does, a verdict of any
//! kind binds what it ran, the start checks that binding at the spawn, and a refusal stored before
//! a restart stays one. Process tests: real shells, the real sandbox where the machine has one.
#![cfg(any(target_os = "macos", all(target_os = "linux", feature = "landlock")))]

mod support;

use std::path::Path;

use serde_json::json;
use spade_testkit::Script;
use support::Result;
use support::sandbox::{asked, output, quoted, reviewed_world, world, world_in};

async fn answer(w: &support::sandbox::World, call: &str, always: bool) -> Result {
    let (status, body) = w
        .spade
        .post(
            &format!("/v1/conversations/{}/approvals/{call}", w.conversation),
            json!({ "allowed": true, "always": always }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    Ok(())
}

/// A script `run.sh` in the bot's folder, and `next.sh`, which writes `outside.txt` beside the
/// test's folders.
fn scripts(w: &support::sandbox::World) -> Result<(std::path::PathBuf, std::path::PathBuf)> {
    let root = w.home.parent().map(Path::to_path_buf).unwrap_or_default();
    let workspace = w.workspaces.of(&w.bot)?.path()?;
    std::fs::write(workspace.join("run.sh"), "echo fine\n")?;
    std::fs::write(
        workspace.join("next.sh"),
        format!("echo ran > {}\n", quoted(&root.join("outside.txt"))),
    )?;
    Ok((root, workspace))
}

#[tokio::test]
async fn an_outside_request_for_git_whose_configuration_runs_a_program_is_refused_not_asked()
-> Result {
    let w = world(true, vec![], |_| {
        vec![
            Script::reply("").call(
                "c1",
                "shell",
                json!({ "command": "git status", "outside_sandbox": true }),
            ),
            Script::reply("Okay."),
        ]
    })
    .await?;
    let workspace = w.workspaces.of(&w.bot)?.path()?;
    // The repository's configuration names a program git runs on its own.
    let git = workspace.join(".git");
    std::fs::create_dir_all(&git)?;
    std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n")?;
    std::fs::write(git.join("config"), "[core]\n\tfsmonitor = ./watch.sh\n")?;
    w.spade
        .say(&w.conversation, "Check the repo outside")
        .await?;
    let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
    assert!(asked(&events).is_empty(), "asked about it");
    let said = output(&events, "c1");
    assert!(said.contains("couldn't be read whole"), "{said}");
    Ok(())
}

#[tokio::test]
async fn a_script_whose_output_goes_outside_is_still_bound_to_what_it_runs() -> Result {
    let w = world(true, vec![], |_| {
        vec![
            Script::reply("").call(
                "c1",
                "shell",
                json!({ "command": "sh run.sh > ../run.log", "outside_sandbox": true }),
            ),
            Script::reply("Okay."),
        ]
    })
    .await?;
    let (root, workspace) = scripts(&w)?;
    w.spade.say(&w.conversation, "Run it outside").await?;
    let events = w
        .spade
        .wait_for(&w.conversation, "approval_requested")
        .await?;
    assert_eq!(asked(&events), ["c1"]);
    // While the person is asked, the script it runs is rewritten.
    std::fs::copy(workspace.join("next.sh"), workspace.join("run.sh"))?;
    answer(&w, "c1", false).await?;
    let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
    let said = output(&events, "c1");
    assert!(said.contains("changed"), "{said}");
    assert!(
        !root.join("outside.txt").exists(),
        "the rewritten script ran"
    );
    Ok(())
}

#[tokio::test]
async fn an_always_allowed_command_doesnt_start_outside_once_an_earlier_command_rewrote_its_script()
-> Result {
    let hold_then_rewrite = || json!({ "command": "sleep 2; cp next.sh run.sh" });
    let run = || json!({ "command": "sh run.sh" });
    // The reviewer can't be reached: each command goes to the person, who allows it always.
    let w = world_in(true, true, vec![], |_| {
        vec![
            Script::reply("")
                .call("a0", "shell", hold_then_rewrite())
                .call("a1", "shell", run()),
            Script::reply("Ran them."),
            Script::reply("").plain(r#"{"title":"Run"}"#),
            // Both again, in one step, on the person's Always allow: the first holds the
            // terminal, then rewrites the script after the second was checked and before it
            // starts.
            Script::reply("")
                .call("c0", "shell", hold_then_rewrite())
                .call("c2", "shell", run()),
            Script::reply("Okay."),
        ]
    })
    .await?;
    let (status, body) = w
        .spade
        .put(
            &format!("/v1/agents/{}/security/commands", w.bot),
            json!({ "commands": "outside" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let (root, workspace) = scripts(&w)?;
    // Nothing to copy yet: the first time, the first command changes nothing.
    let next = std::fs::read_to_string(workspace.join("next.sh"))?;
    std::fs::remove_file(workspace.join("next.sh"))?;
    w.spade.say(&w.conversation, "Run them").await?;
    w.spade
        .wait_for_count(&w.conversation, "approval_requested", 2)
        .await?;
    answer(&w, "a0", true).await?;
    answer(&w, "a1", true).await?;
    let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
    assert!(output(&events, "a1").contains("fine"), "{events:?}");
    std::fs::write(workspace.join("next.sh"), &next)?;
    w.spade.say(&w.conversation, "Again").await?;
    let events = w
        .spade
        .wait_for_count(&w.conversation, "reply_finished", 2)
        .await?;
    // The person's Always allow let both run with no question.
    assert_eq!(asked(&events), ["a0", "a1"], "asked again");
    assert_eq!(
        std::fs::read_to_string(workspace.join("run.sh"))?,
        next,
        "the first command rewrote it"
    );
    let said = output(&events, "c2");
    assert!(said.contains("changed while it waited to start"), "{said}");
    assert!(
        !root.join("outside.txt").exists(),
        "the rewritten script ran"
    );
    Ok(())
}

#[tokio::test]
async fn a_refusal_stored_before_a_restart_still_refuses_once_the_bot_is_in_full_access() -> Result
{
    const REFUSE: &str = r#"{"verdict":"refuse","reason":"Not that file."}"#;
    // No sandbox: the command is reviewed, and the reviewer refuses it.
    let w = reviewed_world(false, vec![], |_| {
        vec![
            Script::reply("").call("c1", "shell", json!({ "command": "echo ran > ran.txt" })),
            Script::reply("").plain(REFUSE),
            Script::reply("Left it."),
            Script::reply("").plain(r#"{"title":"Run"}"#),
        ]
    })
    .await?;
    let workspace = w.workspaces.of(&w.bot)?.path()?;
    std::fs::create_dir_all(&workspace)?;
    w.spade.say(&w.conversation, "Write it").await?;
    w.spade.wait_for(&w.conversation, "reply_finished").await?;
    // Spade stopped between storing the refusal and finishing the call, and the bot was moved
    // to Full access meanwhile.
    let full_access = json!({ "autonomy": "full_access", "full_access_confirmed": true });
    let sql = format!(
        "DELETE FROM events WHERE seq > (SELECT seq FROM events
             WHERE json_extract(body, '$.type') = 'call_reviewed')
           AND conversation_id = (SELECT conversation_id FROM events
             WHERE json_extract(body, '$.type') = 'call_reviewed');
         INSERT INTO events (conversation_id, seq, at_ms, body)
           SELECT conversation_id, seq + 1, at_ms,
             json_object('type', 'turn_paused', 'reply', json_extract(body, '$.reply'))
           FROM events WHERE json_extract(body, '$.type') = 'call_reviewed';
         INSERT INTO settings (key, value) VALUES ('security:{}', '{full_access}')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
        w.bot
    );
    let options = support::Options {
        reviewer: None,
        ..support::Options::default()
    };
    let w = w
        .restart_paused(&sql, vec![Script::reply("Left it.")], options)
        .await?;
    assert_eq!(
        w.security.autonomy(&w.bot),
        spade_core::autonomy::Mode::FullAccess
    );
    let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
    let said = output(&events, "c1");
    assert!(said.contains("Not that file."), "{said}");
    assert!(
        !workspace.join("ran.txt").exists(),
        "the refused command ran"
    );
    Ok(())
}
