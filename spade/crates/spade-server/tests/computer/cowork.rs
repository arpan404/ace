//! Cowork (ADR 0143): the person uses the bot's computer while the bot works. The bot isn't
//! paused, the person's file writes are checked against the revision they opened, the bot yields
//! a file the person just changed, and the bot's next step reads what the person did.

use super::*;

/// Approves every call the conversation asks about, until `call` has finished.
async fn finished(spade: &Spade, conversation: &str, call: &str) -> Result<Vec<Value>> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut approved = std::collections::HashSet::new();
    loop {
        let events = spade.events(conversation).await?;
        if events
            .iter()
            .any(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        {
            return Ok(events);
        }
        let asked: Vec<String> = events
            .iter()
            .filter(|e| e["type"] == "approval_requested")
            .filter_map(|e| e["call_id"].as_str().map(str::to_owned))
            .collect();
        for id in asked {
            if approved.insert(id.clone()) {
                let (status, _) = spade
                    .post(
                        &format!("/v1/conversations/{conversation}/approvals/{id}"),
                        json!({ "allowed": true }),
                    )
                    .await?;
                assert_eq!(status, 202);
            }
        }
        if tokio::time::Instant::now() > deadline {
            return Err(format!("{call} never finished: {:?}", types(&events)).into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn result_of(events: &[Value], call: &str) -> String {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default()
        .to_owned()
}

async fn revision(spade: &Spade, agent: &str, path: &str) -> Result<String> {
    let (status, file) = spade
        .get(&format!("/v1/agents/{agent}/workspace/file?path={path}"))
        .await?;
    assert_eq!(status, 200);
    Ok(file["revision"]
        .as_str()
        .ok_or("the file has no revision")?
        .to_owned())
}

#[tokio::test]
async fn in_cowork_the_bot_keeps_replying_while_the_person_types_and_reads_what_they_did() -> Result
{
    let machine = Machine::new()?;
    let spade = start(&machine, vec![Script::reply("Still here.")], Vec::new()).await?;
    let (agent, conversation) = bot(&spade).await?;
    let mut terminal = prompt(&spade, &agent).await?;
    type_in(
        &spade,
        &agent,
        "echo cowork-$((40+2)) | tee by-person.txt\r",
    )
    .await?;
    terminal
        .until("output", |frame| decoded(frame).contains("cowork-42"))
        .await
        .ok_or("the person's command never showed")?;
    let (_, view) = spade.get(&format!("/v1/agents/{agent}/computer")).await?;
    assert_eq!(view["mode"], "cowork");
    assert_eq!(view["driver"], "bot");
    let shell = view["surfaces"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["kind"] == "terminal"))
        .cloned()
        .unwrap_or_default();
    assert_eq!(shell["person_active"], true);

    // The person keeps typing while the bot answers.
    let (base, input) = (
        spade.base.clone(),
        format!("/v1/agents/{agent}/terminal/input"),
    );
    let typing = tokio::spawn(async move {
        let client = reqwest::Client::new();
        for _ in 0..10 {
            let status = client
                .post(format!("{base}{input}"))
                .bearer_auth(TOKEN)
                .json(&json!({ "data_b64": b64("true\r") }))
                .send()
                .await
                .map(|r| r.status().as_u16())
                .unwrap_or(0);
            if status != 204 {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        204
    });
    spade.say(&conversation, "Are you there?").await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    assert_eq!(typing.await?, 204, "the person's typing is never refused");
    let order = types(&events);
    assert!(!order.contains(&"turn_paused".to_owned()), "{order:?}");
    let activity = order.iter().position(|t| t == "person_activity");
    let step = order.iter().position(|t| t == "step_finished");
    assert!(activity.is_some() && activity < step, "{order:?}");
    let note = events
        .iter()
        .find(|e| e["type"] == "person_activity")
        .ok_or("no activity")?;
    let text = note["text"].as_str().unwrap_or_default();
    assert!(text.contains("They used your terminal"), "{text}");
    assert!(!text.contains("cowork") && !text.contains("echo"), "{text}");
    let read = spade
        .fake
        .seen()
        .iter()
        .map(|s| s.body.to_string())
        .find(|body| body.contains("Are you there?"))
        .unwrap_or_default();
    assert!(
        read.contains("person_activity from=\\\"spade\\\""),
        "{read}"
    );
    assert!(
        !read.contains("cowork-$"),
        "what they typed is never sent: {read}"
    );

    // More typing within the minute waits for a later step rather than a summary every step.
    type_in(&spade, &agent, "true\r").await?;
    spade.say(&conversation, "And now?").await?;
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    assert_eq!(
        types(&events)
            .iter()
            .filter(|t| *t == "person_activity")
            .count(),
        1
    );
    machine.terminals.end_all();
    Ok(())
}

#[tokio::test]
async fn a_persons_write_is_checked_against_the_revision_they_opened_and_the_bot_yields_it()
-> Result {
    let machine = Machine::new()?;
    let spade = start(
        &machine,
        vec![
            Script::reply("").call(
                "c1",
                "workspace_write",
                json!({ "path": "keep.txt", "content": "the bot's" }),
            ),
            Script::reply("I'll leave it."),
        ],
        Vec::new(),
    )
    .await?;
    let (agent, conversation) = bot(&spade).await?;
    let workspace = machine.workspaces.of(&agent)?;
    let root = workspace.path()?;
    let files = format!("/v1/agents/{agent}/files");
    workspace.write_bytes("keep.txt", b"v1", 1024)?;
    let opened = revision(&spade, &agent, "keep.txt").await?;
    // The bot changes it after the person opened it.
    workspace.write_bytes("keep.txt", b"v2", 1024)?;

    let (status, error) = spade
        .put(
            &format!("{files}?path=keep.txt"),
            json!({ "text": "mine", "base": opened }),
        )
        .await?;
    assert_eq!(status, 409);
    assert_eq!(error["error"], "changed");
    let now = revision(&spade, &agent, "keep.txt").await?;
    assert_eq!(error["revision"], now.as_str());
    assert_ne!(now, opened);
    let (status, _) = spade
        .post(
            &format!("{files}/move"),
            json!({ "from": "keep.txt", "to": "moved.txt", "base": opened }),
        )
        .await?;
    assert_eq!(status, 409);
    let (status, _) = spade
        .delete(&format!(
            "/v1/agents/{agent}/workspace?path=keep.txt&base={opened}"
        ))
        .await?;
    assert_eq!(status, 409);
    assert_eq!(std::fs::read(root.join("keep.txt"))?, b"v2");
    assert!(!root.join("moved.txt").exists());

    let mut live = Live::open(&spade, &format!("/v1/conversations/{conversation}/live")).await?;
    let (status, _) = spade
        .put(
            &format!("{files}?path=keep.txt"),
            json!({ "text": "mine", "base": now }),
        )
        .await?;
    assert_eq!(status, 204);
    assert_eq!(std::fs::read(root.join("keep.txt"))?, b"mine");
    assert!(workspace.file_trusted("keep.txt", b"mine"));
    assert!(
        live.until("files", |f| f["paths"] == json!(["keep.txt"]))
            .await
            .is_some()
    );
    // A new file needs no revision.
    let (status, _) = spade
        .put(&format!("{files}?path=new.md"), json!({ "text": "# New" }))
        .await?;
    assert_eq!(status, 204);

    spade.say(&conversation, "Tidy keep.txt").await?;
    let events = finished(&spade, &conversation, "c1").await?;
    let result = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "c1")
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default();
    assert!(
        result.starts_with("Not run: the person changed keep.txt"),
        "{result}"
    );
    assert_eq!(std::fs::read(root.join("keep.txt"))?, b"mine");
    let activity = events
        .iter()
        .find(|e| e["type"] == "person_activity")
        .ok_or("no activity")?;
    assert_eq!(
        activity["data"],
        json!(["changed: keep.txt", "new: new.md"])
    );
    let text = activity["text"].as_str().unwrap_or_default();
    assert!(text.contains("They changed 2 files"), "{text}");
    assert!(!text.contains("keep.txt"), "names go only as data: {text}");
    spade.wait_for(&conversation, "reply_finished").await?;
    Ok(())
}

#[tokio::test]
async fn a_bot_write_and_a_persons_write_racing_on_one_file_never_both_land() -> Result {
    let machine = Machine::new()?;
    // The bot's write stops between its checks and its write until the test lets it go.
    let (reached_tx, reached) = std::sync::mpsc::channel::<()>();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let (reached_tx, released) = (
        std::sync::Mutex::new(reached_tx),
        std::sync::Mutex::new(released),
    );
    machine.workspaces.before_bot_commit(move |_| {
        let _ = reached_tx.lock().map(|tx| tx.send(()));
        let _ = released
            .lock()
            .map(|rx| rx.recv_timeout(Duration::from_secs(10)));
    });
    let spade = start(
        &machine,
        vec![
            Script::reply("").call(
                "c1",
                "workspace_write",
                json!({ "path": "keep.txt", "content": "the bot's" }),
            ),
            Script::reply("Written."),
        ],
        Vec::new(),
    )
    .await?;
    let (agent, conversation) = bot(&spade).await?;
    let workspace = machine.workspaces.of(&agent)?;
    workspace.write_bytes("keep.txt", b"v1", 1024)?;
    let opened = revision(&spade, &agent, "keep.txt").await?;

    spade.say(&conversation, "Write keep.txt").await?;
    // Approve the write if it asks, until it reaches its hold.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut approved = false;
    while reached.try_recv().is_err() {
        if !approved
            && spade
                .events(&conversation)
                .await?
                .iter()
                .any(|e| e["type"] == "approval_requested")
        {
            let (status, _) = spade
                .post(
                    &format!("/v1/conversations/{conversation}/approvals/c1"),
                    json!({ "allowed": true }),
                )
                .await?;
            assert_eq!(status, 202);
            approved = true;
        }
        if tokio::time::Instant::now() > deadline {
            return Err("the bot's write never reached its hold".into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // The person saves with the revision they opened while the bot is between check and write.
    let put = tokio::spawn({
        let (base, agent, opened) = (spade.base.clone(), agent.clone(), opened.clone());
        async move {
            let response = reqwest::Client::new()
                .put(format!("{base}/v1/agents/{agent}/files?path=keep.txt"))
                .bearer_auth(TOKEN)
                .json(&json!({ "text": "mine", "base": opened }))
                .send()
                .await
                .ok()?;
            let status = response.status().as_u16();
            Some((status, response.json::<Value>().await.ok()?))
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!put.is_finished(), "the person's write waits for the bot's");
    release.send(())?;
    let (status, error) = put.await?.ok_or("the person's write failed")?;
    let events = finished(&spade, &conversation, "c1").await?;
    assert!(result_of(&events, "c1").starts_with("Wrote"), "{events:?}");
    assert_eq!(status, 409, "the bot's write landed first: {error}");
    assert_eq!(error["error"], "changed");
    assert_eq!(
        std::fs::read(workspace.path()?.join("keep.txt"))?,
        b"the bot's"
    );
    Ok(())
}

#[tokio::test]
async fn the_bot_yields_a_file_the_person_changed_however_it_spells_the_path() -> Result {
    let machine = Machine::new()?;
    let spade = start(
        &machine,
        vec![
            Script::reply("")
                .call(
                    "c1",
                    "workspace_write",
                    json!({ "path": "alias/a.txt", "content": "b" }),
                )
                .call(
                    "c2",
                    "workspace_write",
                    json!({ "path": "gone.txt", "content": "b" }),
                )
                .call(
                    "c3",
                    "workspace_write",
                    json!({ "path": "notes.txt", "content": "b" }),
                ),
            Script::reply("Done."),
        ],
        Vec::new(),
    )
    .await?;
    let (agent, conversation) = bot(&spade).await?;
    let workspace = machine.workspaces.of(&agent)?;
    let root = workspace.path()?;
    workspace.mkdir("real")?;
    std::os::unix::fs::symlink(root.join("real"), root.join("alias"))?;
    workspace.write_bytes("gone.txt", b"x", 1024)?;
    let files = format!("/v1/agents/{agent}/files");
    for (path, text) in [("real/a.txt", "mine"), ("Notes.txt", "mine")] {
        let (status, _) = spade
            .put(&format!("{files}?path={path}"), json!({ "text": text }))
            .await?;
        assert_eq!(status, 204);
    }
    let (status, _) = spade
        .delete(&format!("/v1/agents/{agent}/workspace?path=gone.txt"))
        .await?;
    assert_eq!(status, 204);
    // Whether this volume takes notes.txt for Notes.txt.
    let ignores_case = root.join("NOTES.TXT").exists();

    spade.say(&conversation, "Write them").await?;
    let events = finished(&spade, &conversation, "c3").await?;
    for call in ["c1", "c2"] {
        let result = result_of(&events, call);
        assert!(
            result.starts_with("Not run: the person changed"),
            "{call}: {result}"
        );
    }
    assert_eq!(std::fs::read(root.join("real/a.txt"))?, b"mine");
    assert!(
        !root.join("gone.txt").exists(),
        "a file made again counts too"
    );
    let third = result_of(&events, "c3");
    assert_eq!(
        third.starts_with("Not run: the person changed"),
        ignores_case,
        "{third}"
    );
    Ok(())
}

#[test]
fn the_persons_recent_changes_survive_a_restart_until_their_window_ends() -> Result {
    let machine = Machine::new()?;
    let clock = support::ManualClock::at(1_000_000);
    let open = || {
        Computers::open(
            machine.root.path().join("computer"),
            machine.workspaces.clone(),
            machine.terminals.clone(),
            clock.clone(),
        )
    };
    machine
        .workspaces
        .of("a_1")?
        .write_bytes("plan.md", b"x", 1024)?;
    open().person_changed("a_1", &[("plan.md".to_owned(), "changed")]);
    clock.set(1_020_000);
    let restarted = open();
    assert_eq!(
        restarted.person_changed_recently("a_1", "plan.md"),
        Some(20)
    );
    assert_eq!(restarted.mode("a_1"), spade_server::computer::Mode::Cowork);
    clock.set(1_031_000);
    assert_eq!(open().person_changed_recently("a_1", "plan.md"), None);
    Ok(())
}

#[tokio::test]
async fn a_file_grown_past_what_has_a_revision_is_a_conflict_not_a_refusal() -> Result {
    let machine = Machine::new()?;
    let spade = start(&machine, vec![Script::reply("Hi")], Vec::new()).await?;
    let (agent, _) = bot(&spade).await?;
    let workspace = machine.workspaces.of(&agent)?;
    workspace.write_bytes("big.bin", b"small", 1024)?;
    let opened = revision(&spade, &agent, "big.bin").await?;
    std::fs::write(
        workspace.path()?.join("big.bin"),
        vec![0_u8; 32 * 1024 * 1024 + 1],
    )?;
    let (status, error) = spade
        .put(
            &format!("/v1/agents/{agent}/files?path=big.bin"),
            json!({ "text": "mine", "base": opened }),
        )
        .await?;
    assert_eq!(status, 409, "{error}");
    assert_eq!(error["error"], "changed");
    assert_eq!(error["revision"], Value::Null);
    Ok(())
}
