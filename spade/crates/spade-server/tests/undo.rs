//! Undo in the conversation (ADR 0167, amendment 2): a turn's file changes can be undone on their
//! own, from the checkpoint taken before its first unreviewed work, and the person sees what goes
//! back before it does. Process tests: the bot's writes run in the real sandbox.
#![cfg(any(target_os = "macos", all(target_os = "linux", feature = "landlock")))]

mod support;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::Result;
use support::sandbox::world;

fn write(call: &str, path: &str, content: &str) -> Script {
    Script::reply("").call(
        call,
        "workspace_write",
        json!({"path": path, "content": content}),
    )
}

/// The position of the `tool_started` of call `call` in the conversation's stored events.
async fn started_at(w: &support::sandbox::World, call: &str) -> Result<i64> {
    let (_, rows) = w
        .spade
        .get(&format!("/v1/conversations/{}/events", w.conversation))
        .await?;
    rows.as_array()
        .and_then(|rows| {
            rows.iter().find(|row| {
                row["event"]["type"] == "tool_started" && row["event"]["call_id"] == call
            })
        })
        .and_then(|row| row["seq"].as_i64())
        .ok_or_else(|| format!("no tool_started for {call}: {rows}").into())
}

fn listed(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .map(|all| all.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

#[tokio::test]
async fn undoing_a_turn_restores_the_files_it_changed_and_lists_them_first() -> Result {
    let w = world(true, vec![], |_| {
        vec![
            write("c1", "plan.md", "first plan"),
            Script::reply("Wrote the plan."),
            // The conversation's title.
            Script::reply("Plan"),
            write("c2", "plan.md", "second plan"),
            write("c3", "extra.md", "made in turn two"),
            Script::reply("Rewrote it."),
        ]
    })
    .await?;
    let workspace = w
        .home
        .parent()
        .map(|root| root.join("data/workspace").join(&w.bot))
        .unwrap_or_default();
    std::fs::create_dir_all(&workspace)?;
    std::fs::write(workspace.join("old.md"), "from before")?;

    w.spade.say(&w.conversation, "Write a plan").await?;
    w.spade.wait_for(&w.conversation, "reply_finished").await?;
    // The next turn comes well within the minute between automatic checkpoints.
    w.spade.say(&w.conversation, "Rewrite it").await?;
    w.spade
        .wait_for_count(&w.conversation, "reply_finished", 2)
        .await?;
    std::fs::remove_file(workspace.join("old.md"))?;

    // Each step's start carries what its tool declared to the gate: the app reads a send or a
    // payment from it, never from the tool's name.
    let (_, rows) = w
        .spade
        .get(&format!("/v1/conversations/{}/events", w.conversation))
        .await?;
    let effects: Vec<&str> = rows
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|row| row["event"]["type"] == "tool_started")
                .filter_map(|row| row["event"]["effect"].as_str())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(effects, ["write_local"; 3], "{rows}");

    // What undoing the second turn (from its first file-changing step) would do, before it does.
    let seq = started_at(&w, "c2").await?;
    let (status, preview) = w
        .spade
        .get(&format!("/v1/agents/{}/checkpoints/undo?seq={seq}", w.bot))
        .await?;
    assert_eq!(status, 200, "{preview}");
    assert_eq!(listed(&preview["changes"]["changed"]), vec!["plan.md"]);
    assert_eq!(listed(&preview["changes"]["added"]), vec!["extra.md"]);
    assert_eq!(listed(&preview["changes"]["deleted"]), vec!["old.md"]);
    assert_eq!(
        std::fs::read_to_string(workspace.join("plan.md"))?,
        "second plan",
        "a preview changes nothing"
    );

    let checkpoint = preview["checkpoint"]["id"].as_str().unwrap_or_default();
    let (status, restored) = w
        .spade
        .post(
            &format!("/v1/agents/{}/checkpoints/{checkpoint}/restore", w.bot),
            json!({}),
        )
        .await?;
    assert_eq!(status, 200, "{restored}");
    // The second turn's changes are gone; the first turn's stay.
    assert_eq!(
        std::fs::read_to_string(workspace.join("plan.md"))?,
        "first plan"
    );
    assert!(!workspace.join("extra.md").exists());
    assert!(workspace.join("old.md").exists());

    // The bot is told, so it doesn't rely on files that went back.
    let events = w.spade.events(&w.conversation).await?;
    let told = events
        .iter()
        .filter(|e| e["type"] == "person_activity")
        .filter_map(|e| e["text"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(told.len(), 1, "{told:?}");
    assert!(told[0].contains("undid changes"), "{told:?}");
    Ok(())
}

#[tokio::test]
async fn a_new_bots_first_write_undoes_back_to_its_empty_folder() -> Result {
    let w = world(true, vec![], |_| {
        vec![
            write("c1", "plan.md", "first plan"),
            Script::reply("Wrote it."),
        ]
    })
    .await?;
    w.spade.say(&w.conversation, "Write a plan").await?;
    w.spade.wait_for(&w.conversation, "reply_finished").await?;
    // The folder didn't exist before the first write: it was made empty and checkpointed, so
    // that write can be undone too.
    let seq = started_at(&w, "c1").await?;
    let (status, preview) = w
        .spade
        .get(&format!("/v1/agents/{}/checkpoints/undo?seq={seq}", w.bot))
        .await?;
    assert_eq!(status, 200, "{preview}");
    assert_eq!(listed(&preview["changes"]["added"]), vec!["plan.md"]);
    assert!(listed(&preview["changes"]["changed"]).is_empty(), "{preview}");
    Ok(())
}
