//! Cowork (ADR 0143): the person uses the bot's computer while the bot works. The bot isn't
//! paused, the person's file writes are checked against the revision they opened, the bot yields
//! a file the person just changed, and the bot's next step reads what the person did.

use super::*;

/// Approves every call the conversation asks about, until `call` has finished.
async fn finished(spade: &Spade, conversation: &str, call: &str) -> Result<Vec<Value>> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut approved = false;
    loop {
        let events = spade.events(conversation).await?;
        if events
            .iter()
            .any(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        {
            return Ok(events);
        }
        if !approved
            && events
                .iter()
                .any(|e| e["type"] == "approval_requested" && e["call_id"] == call)
        {
            let (status, _) = spade
                .post(
                    &format!("/v1/conversations/{conversation}/approvals/{call}"),
                    json!({ "allowed": true }),
                )
                .await?;
            assert_eq!(status, 202);
            approved = true;
        }
        if tokio::time::Instant::now() > deadline {
            return Err(format!("{call} never finished: {:?}", types(&events)).into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
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
