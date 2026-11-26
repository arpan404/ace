//! A provider closes its calls and holds the final frame until the test releases it.

mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::effect::Effect;
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::{Route, Script};
use support::{FakeTool, Options, Result, Spade};
use tokio::sync::Notify;

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Streaming"}"#)
}

fn read() -> FakeTool {
    FakeTool::new("read_example", Risk::Read, "read result").early_read()
}

fn read_step() -> Script {
    Script::reply("Reading.").call("call_0", "read_example", json!({}))
}

async fn until(mut ready: impl FnMut() -> bool) -> Result {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await?;
    Ok(())
}

fn count(calls: &Mutex<Vec<Value>>) -> usize {
    calls.lock().unwrap_or_else(|p| p.into_inner()).len()
}

fn no_call_events(events: &[Value]) -> bool {
    !events.iter().any(|e| {
        matches!(
            e["type"].as_str(),
            Some(
                "step_finished"
                    | "tool_started"
                    | "tool_finished"
                    | "call_reviewed"
                    | "approval_requested"
            )
        )
    })
}

#[tokio::test]
async fn streaming_read_starts_before_the_step_and_reused_ids_get_their_own_results() -> Result {
    let release = Arc::new(Notify::new());
    let second = Arc::new(Notify::new());
    let read = read();
    let runs = read.calls();
    let spade = Spade::start_turns(
        vec![
            read_step().hold_stream_end(release.clone()),
            read_step().hold_stream_end(second.clone()),
            Script::reply("Done."),
        ],
        title(),
        vec![Arc::new(read)],
    )
    .await?;
    let id = spade.ask("Read twice").await?;
    until(|| count(&runs) == 1).await?;
    assert!(no_call_events(&spade.events(&id).await?));
    release.notify_one();
    until(|| count(&runs) == 2).await?;
    assert_eq!(
        spade
            .events(&id)
            .await?
            .iter()
            .filter(|event| event["type"] == "step_finished")
            .count(),
        1,
    );
    second.notify_one();
    let events = spade.wait_for_count(&id, "tool_finished", 2).await?;
    let ids: Vec<_> = events
        .iter()
        .filter(|e| e["type"] == "step_finished")
        .filter_map(|e| e["calls"][0]["id"].as_str())
        .collect();
    assert_eq!(ids.len(), 2, "{events:?}");
    assert_eq!(ids[0], "call_0");
    assert_ne!(ids[0], ids[1]);
    let results: Vec<_> = events
        .iter()
        .filter(|e| e["type"] == "tool_finished")
        .collect();
    for (result, id) in results.into_iter().zip(ids) {
        assert_eq!(result["call_id"], id);
        assert_eq!(result["content"], "read result");
    }
    assert_eq!(count(&runs), 2);
    Ok(())
}

#[tokio::test]
async fn streaming_write_that_needs_the_person_waits_for_the_stored_step() -> Result {
    let release = Arc::new(Notify::new());
    let read = read();
    let reads = read.calls();
    let write = FakeTool::new("pay_example", Risk::Write, "paid").declares(Effect::Pay);
    let writes = write.calls();
    let spade = Spade::start_turns(
        vec![
            read_step()
                .call("pay", "pay_example", json!({}))
                .hold_stream_end(release.clone()),
        ],
        title(),
        vec![Arc::new(read), Arc::new(write)],
    )
    .await?;
    let id = spade.ask("Read and pay").await?;
    until(|| count(&reads) == 1).await?;
    assert!(no_call_events(&spade.events(&id).await?));
    assert_eq!(count(&writes), 0);
    release.notify_one();
    let events = spade.wait_for(&id, "approval_requested").await?;
    assert!(events.iter().any(|e| e["type"] == "step_finished"));
    assert_eq!(count(&writes), 0);
    Ok(())
}

#[tokio::test]
async fn streaming_review_starts_early_and_its_approval_runs_the_write_after_the_step() -> Result {
    let release = Arc::new(Notify::new());
    let write = FakeTool::new("post_example", Risk::Write, "posted").declares(Effect::Network);
    let writes = write.calls();
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(write)];
    let spade = Spade::start_routed(
        vec![Route::when(
            "You review one step an assistant bot",
            vec![Script::reply("").plain(r#"{"verdict":"approve","reason":"The person asked."}"#)],
        )],
        vec![
            Script::reply("Posting.")
                .call("write", "post_example", json!({}))
                .hold_stream_end(release.clone()),
            Script::reply("Posted."),
            title(),
        ],
        tools,
        Options {
            reviewer: None,
            ..Options::default()
        },
    )
    .await?;
    let id = spade.ask("Post the update").await?;
    let reviews = || {
        spade
            .fake
            .seen()
            .iter()
            .filter(|r| r.body["stream"] != true && r.body.to_string().contains("post_example"))
            .count()
    };
    until(|| reviews() == 1).await?;
    assert!(no_call_events(&spade.events(&id).await?));
    assert_eq!(count(&writes), 0);
    let store = spade_store::Store::open(&spade.dir.path().join("spade.sqlite"))?;
    let review_spend = || {
        store
            .spent_by_role(&id, 0)
            .unwrap_or_default()
            .get("review")
            .copied()
    };
    until(|| review_spend().is_some()).await?;
    let spent_early = review_spend();
    release.notify_one();
    let events = spade.wait_for(&id, "tool_finished").await?;
    assert_eq!(review_spend(), spent_early);
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "call_reviewed" && e["verdict"] == "allow")
    );
    assert_eq!(reviews(), 1);
    assert_eq!(count(&writes), 1);
    Ok(())
}

#[tokio::test]
async fn streaming_stop_discards_the_early_read() -> Result {
    let read = read();
    let runs = read.calls();
    let spade = Spade::start_turns(
        vec![read_step().hold_stream_end(Arc::new(Notify::new()))],
        title(),
        vec![Arc::new(read)],
    )
    .await?;
    let id = spade.ask("Read once").await?;
    until(|| count(&runs) == 1).await?;
    assert_eq!(
        spade
            .post(&format!("/v1/conversations/{id}/stop"), json!({}))
            .await?
            .0,
        202
    );
    let events = spade.wait_for(&id, "reply_stopped").await?;
    assert!(no_call_events(&events), "{events:?}");
    assert_eq!(count(&runs), 1);
    Ok(())
}

#[tokio::test]
async fn streaming_cut_discards_the_early_read_and_does_not_resend() -> Result {
    let release = Arc::new(Notify::new());
    let read = read();
    let runs = read.calls();
    let spade = Spade::start_turns(
        vec![read_step().cut_stream_end(release.clone())],
        title(),
        vec![Arc::new(read)],
    )
    .await?;
    let id = spade.ask("Read once").await?;
    until(|| count(&runs) == 1).await?;
    release.notify_one();
    let events = spade.wait_for(&id, "reply_failed").await?;
    assert!(no_call_events(&events), "{events:?}");
    assert_eq!(
        spade
            .fake
            .seen()
            .iter()
            .filter(|r| r.body["stream"] == true)
            .count(),
        1
    );
    Ok(())
}

#[tokio::test]
async fn streaming_crash_recovery_has_no_early_read_to_replay() -> Result {
    let read = read();
    let runs = read.calls();
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(read)];
    let spade = Spade::start_turns(
        vec![read_step().hold_stream_end(Arc::new(Notify::new()))],
        title(),
        tools.clone(),
    )
    .await?;
    let id = spade.ask("Read once").await?;
    until(|| count(&runs) == 1).await?;
    spade.engine.pause_for_stop(Duration::ZERO).await;
    let events = spade.wait_for(&id, "turn_paused").await?;
    assert!(no_call_events(&events), "{events:?}");
    // Stop the old worker and restore the log as it stood before that graceful pause.
    let restarted = spade
        .restart_after_crash(
            "DELETE FROM events WHERE json_extract(body, '$.type') = 'turn_paused'",
            tools,
            vec![Script::reply("Unexpected replay.")],
        )
        .await?;
    let events = restarted.wait_for(&id, "reply_interrupted").await?;
    assert!(no_call_events(&events), "{events:?}");
    assert_eq!(count(&runs), 1);
    assert!(
        restarted
            .fake
            .seen()
            .iter()
            .all(|r| r.body["stream"] != true)
    );
    Ok(())
}

#[tokio::test]
async fn streaming_steer_changes_the_review_prompt_before_a_write_can_run() -> Result {
    let release = Arc::new(Notify::new());
    let write = FakeTool::new("post_example", Risk::Write, "posted").declares(Effect::Network);
    let writes = write.calls();
    let spade = Spade::start_routed(
        vec![Route::when(
            "You review one step an assistant bot",
            vec![
                Script::reply("")
                    .plain(r#"{"verdict":"approve","reason":"The person asked."}"#)
                    .held(Duration::from_secs(30)),
                Script::reply("")
                    .plain(r#"{"verdict":"refuse","reason":"The person changed course."}"#),
            ],
        )],
        vec![
            Script::reply("Posting.")
                .call("write", "post_example", json!({}))
                .hold_stream_end(release.clone()),
            title(),
        ],
        vec![Arc::new(write)],
        Options {
            reviewer: None,
            ..Options::default()
        },
    )
    .await?;
    let id = spade.ask("Post the update").await?;
    let reviews = || {
        spade
            .fake
            .seen()
            .into_iter()
            .filter(|r| {
                r.body
                    .to_string()
                    .contains("You review one step an assistant bot")
            })
            .collect::<Vec<_>>()
    };
    until(|| reviews().len() == 1).await?;
    spade.say(&id, "Hold off on posting.").await?;
    release.notify_one();
    let events = spade.wait_for(&id, "tool_finished").await?;
    let reviews = reviews();
    assert_eq!(reviews.len(), 2);
    assert!(reviews[1].body.to_string().contains("Hold off on posting."));
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "call_reviewed" && e["verdict"] == "refuse")
    );
    assert!(
        !events
            .iter()
            .any(|event| event["type"] == "approval_requested")
    );
    assert_eq!(count(&writes), 0);
    Ok(())
}

#[tokio::test]
async fn streaming_changed_final_arguments_discard_the_early_result() -> Result {
    let terminal = Arc::new(Notify::new());
    let read = read();
    let runs = read.calls();
    let spade = Spade::start_turns(
        vec![
            Script::reply("Reading.")
                .call("c", "read_example", json!(1))
                .late_chat_arguments("2")
                .hold_stream_end(terminal.clone()),
            Script::reply("Done."),
        ],
        title(),
        vec![Arc::new(read)],
    )
    .await?;
    let id = spade.ask("Read the value.").await?;
    until(|| count(&runs) == 1).await?;
    assert!(no_call_events(&spade.events(&id).await?));
    terminal.notify_one();
    let events = spade.wait_for(&id, "tool_finished").await?;
    assert!(
        events.iter().any(|e| e["calls"][0]["arguments"] == 12),
        "{events:?}"
    );
    assert_eq!(
        *runs.lock().unwrap_or_else(|p| p.into_inner()),
        vec![json!(1), json!(12)]
    );
    Ok(())
}

#[tokio::test]
async fn streaming_review_setting_change_discards_the_pending_verdict() -> Result {
    let terminal = Arc::new(Notify::new());
    let write = FakeTool::new("post_example", Risk::Write, "posted").declares(Effect::Network);
    let writes = write.calls();
    let spade = Spade::start_routed(
        vec![Route::when(
            "You review one step an assistant bot",
            vec![
                Script::reply("")
                    .plain(r#"{"verdict":"approve","reason":"Old model."}"#)
                    .held(Duration::from_secs(30)),
                Script::reply("").plain(r#"{"verdict":"refuse","reason":"New model."}"#),
            ],
        )],
        vec![
            Script::reply("Posting.")
                .call("c", "post_example", json!({}))
                .hold_stream_end(terminal.clone()),
            title(),
        ],
        vec![Arc::new(write)],
        Options {
            reviewer: Some("fake/m".to_owned()),
            ..Options::default()
        },
    )
    .await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints/fake/models",
            json!({ "id": "other", "capabilities": ["tools"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let id = spade.ask("Post the update.").await?;
    until(|| {
        spade
            .fake
            .seen()
            .iter()
            .any(|r| r.body["stream"] != true && r.body.to_string().contains("post_example"))
    })
    .await?;
    let (status, body) = spade
        .put("/v1/oversight", json!({"review_model":"fake/other"}))
        .await?;
    assert_eq!(status, 200, "{body}");
    terminal.notify_one();
    let events = spade.wait_for(&id, "tool_finished").await?;
    assert!(
        events.iter().any(|e| e["type"] == "call_reviewed"
            && e["model"] == "fake/other"
            && e["verdict"] == "refuse"),
        "{events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|event| event["type"] == "approval_requested")
    );
    assert_eq!(count(&writes), 0);
    Ok(())
}

#[tokio::test]
async fn streaming_cancelled_review_keeps_spend_without_a_tool_verdict() -> Result {
    for stop in [false, true] {
        let cut = Arc::new(Notify::new());
        let write = FakeTool::new("post_example", Risk::Write, "posted").declares(Effect::Network);
        let writes = write.calls();
        let spade = Spade::start_routed(
            vec![Route::when(
                "You review one step an assistant bot",
                vec![
                    Script::reply("")
                        .plain(r#"{"verdict":"approve","reason":"Asked."}"#)
                        .held(Duration::from_secs(30)),
                ],
            )],
            vec![
                Script::reply("Posting.")
                    .call("c", "post_example", json!({}))
                    .cut_stream_end(cut.clone()),
            ],
            vec![Arc::new(write)],
            Options {
                reviewer: Some("fake/m".to_owned()),
                ..Options::default()
            },
        )
        .await?;
        let id = spade.ask("Post the update.").await?;
        until(|| {
            spade
                .fake
                .seen()
                .iter()
                .any(|r| r.body["stream"] != true && r.body.to_string().contains("post_example"))
        })
        .await?;
        let close = if stop {
            assert_eq!(
                spade
                    .post(&format!("/v1/conversations/{id}/stop"), json!({}))
                    .await?
                    .0,
                202,
            );
            "reply_stopped"
        } else {
            cut.notify_one();
            "reply_failed"
        };
        let events = spade.wait_for(&id, close).await?;
        assert!(no_call_events(&events), "{events:?}");
        assert_eq!(count(&writes), 0);
        let store = spade_store::Store::open(&spade.dir.path().join("spade.sqlite"))?;
        assert!(store.spent_by_role(&id, 0)?["review"] > 0);
    }
    Ok(())
}

async fn workspace_spade(
    workspaces: &spade_server::workspace::Workspaces,
    scripts: Vec<Script>,
) -> Result<Spade> {
    use spade_server::tools::EngineHandle;
    use spade_server::workspace::{shell::Shell, workspace_tools};
    let bots = EngineHandle::default();
    let spade = Spade::start_routed(
        vec![Route::when(r#""stream":true"#, scripts)],
        vec![title()],
        workspace_tools(workspaces.clone(), bots.clone(), Shell::system()),
        Options {
            workspaces: Some(workspaces.clone()),
            limits: spade_server::engine::Limits {
                max_parallel_tools: 1,
                ..Options::default().limits
            },
            ..Options::default()
        },
    )
    .await?;
    bots.set(&spade.engine);
    Ok(spade)
}

fn file_step(terminal: Arc<Notify>) -> Script {
    Script::reply("Reading.")
        .call("file", "workspace_read", json!({"path":"note.txt"}))
        .hold_stream_end(terminal)
}

#[tokio::test]
async fn streaming_workspace_read_rereads_changed_bytes_and_trust() -> Result {
    for replacement in [Some("new untrusted content"), None] {
        let dir = tempfile::tempdir()?;
        let workspaces = spade_server::workspace::Workspaces::new(dir.path());
        let sampled = Arc::new(Notify::new());
        let signal = sampled.clone();
        workspaces.after_early_read(move |_| signal.notify_one());
        let terminal = Arc::new(Notify::new());
        let spade = workspace_spade(
            &workspaces,
            vec![file_step(terminal.clone()), Script::reply("Done."), title()],
        )
        .await?;
        let bot = spade.new_agent("Files", "").await?;
        let id = bot["conversation"].as_str().ok_or("missing conversation")?;
        let workspace = workspaces.of(bot["id"].as_str().ok_or("missing bot")?)?;
        workspace.write("note.txt", "old trusted")?;
        workspace
            .trust()
            .record_write("note.txt", b"old trusted", None);
        spade.say(id, "Read the note.").await?;
        tokio::time::timeout(Duration::from_secs(5), sampled.notified()).await?;
        assert!(no_call_events(&spade.events(id).await?));
        if let Some(replacement) = replacement {
            workspace.write("note.txt", replacement)?;
        }
        let expected = replacement.unwrap_or("old trusted");
        workspace
            .trust()
            .record_write("note.txt", expected.as_bytes(), Some("untrusted"));
        terminal.notify_one();
        let events = spade.wait_for(id, "tool_finished").await?;
        let output = events
            .iter()
            .find(|e| e["type"] == "tool_finished")
            .ok_or("missing read")?;
        assert!(
            output["content"]
                .as_str()
                .unwrap_or_default()
                .contains(expected),
            "{output:?}"
        );
        assert_eq!(output["untrusted"], true);
    }
    Ok(())
}

#[tokio::test]
async fn streaming_stop_keeps_the_permit_until_the_blocking_read_exits() -> Result {
    let dir = tempfile::tempdir()?;
    let workspaces = spade_server::workspace::Workspaces::new(dir.path());
    let started = Arc::new(Notify::new());
    let (release, wait) = std::sync::mpsc::channel();
    let wait = Mutex::new(Some(wait));
    let first_signal = started.clone();
    workspaces.after_early_read(move |_| {
        let wait = wait.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(wait) = wait {
            first_signal.notify_one();
            let _ = wait.recv_timeout(Duration::from_secs(10));
        }
    });
    let spade = workspace_spade(
        &workspaces,
        vec![
            file_step(Arc::new(Notify::new())),
            Script::reply("Searching.").call("search", "tool_search", json!({"query":"workspace"})),
            Script::reply("Done."),
            title(),
        ],
    )
    .await?;
    let bot = spade.new_agent("Files", "").await?;
    let id = bot["conversation"].as_str().ok_or("missing conversation")?;
    let workspace = workspaces.of(bot["id"].as_str().ok_or("missing bot")?)?;
    workspace.write("note.txt", "current")?;
    spade.say(id, "Read the note.").await?;
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await?;
    assert_eq!(
        spade
            .post(&format!("/v1/conversations/{id}/stop"), json!({}))
            .await?
            .0,
        202
    );
    let stopped = spade.wait_for(id, "reply_stopped").await?;
    assert!(no_call_events(&stopped), "{stopped:?}");
    spade.say(id, "List the workspace now.").await?;
    spade.wait_for(id, "step_finished").await?;
    assert!(
        tokio::time::timeout(
            Duration::from_millis(200),
            spade.wait_for(id, "tool_started"),
        )
        .await
        .is_err()
    );
    release.send(())?;
    spade.wait_for(id, "tool_finished").await?;
    Ok(())
}
