//! What an orchestration tree (ADR 0161) must never get wrong, through the real API with a
//! scripted model and a fake ace: a maker's words never count as the person's, Stop reaches a
//! worker made as it is pressed, an ace child reads as running until ace confirms it stopped, a
//! grant taken from a maker is checked where an approved call runs, a kept bot's queued workers
//! start, and a worker's model follows the person's routing rules.
//!
//! Model calls take scripts in the order they arrive; a maker's step that makes or messages a
//! worker also calls `pause`, so the worker's calls arrive before the maker's next step.

#[path = "../../spade-ace/tests/support/fake_mcp.rs"]
#[allow(dead_code)]
mod fake_mcp;
mod support;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fake_mcp::{FakeMcp, tool};
use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::tools::{Tool, ToolSource, Toolbox};
use spade_testkit::Script;
use support::{FakeTool, Options, Result, Spade};

fn pause(ms: u64) -> FakeTool {
    FakeTool::new("pause", Risk::Read, "ok").slow(Duration::from_millis(ms))
}

fn boxed(list: Vec<FakeTool>) -> Vec<Arc<dyn Tool>> {
    list.into_iter()
        .map(|tool| Arc::new(tool) as Arc<dyn Tool>)
        .collect()
}

fn warm_up() -> Vec<Script> {
    vec![
        Script::reply("Hello."),
        Script::reply("").plain(r#"{"title":"Lead"}"#),
    ]
}

fn approve() -> Script {
    Script::reply("").plain(r#"{"verdict":"approve","reason":"It serves the task."}"#)
}

fn refuse() -> Script {
    Script::reply("").plain(r#"{"verdict":"refuse","reason":"Nobody asked for a payment."}"#)
}

/// Spade with the fake model as the reviewer, and `options` otherwise.
fn reviewed(options: Options) -> Options {
    Options {
        reviewer: None,
        ..options
    }
}

async fn lead(spade: &Spade) -> Result<(String, String)> {
    let agent = spade.new_agent("Lead", "").await?;
    let id = agent["id"].as_str().unwrap_or_default().to_owned();
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;
    Ok((id, conversation))
}

async fn named(spade: &Spade, name: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    body["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|a| a["name"] == name).cloned())
        .ok_or_else(|| format!("no agent {name}").into())
}

async fn state_of(spade: &Spade, id: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|a| a["id"] == id).cloned())
        .map(|a| a["state"].clone())
        .unwrap_or_default())
}

fn conversation_of(agent: &Value) -> String {
    agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

async fn until<F, Fut>(what: &str, test: F) -> Result
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<bool>>,
{
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if test().await? {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!("never: {what}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn result_of(events: &[Value], call: &str) -> Value {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        .cloned()
        .unwrap_or_default()
}

#[tokio::test]
async fn a_refused_call_handed_down_to_a_worker_is_refused_again_then_reaches_the_person() -> Result
{
    let pay = FakeTool::new("pay", Risk::Write, "paid");
    let paid = pay.calls();
    let mut scripts = warm_up();
    scripts.extend([
        Script::reply("")
            .call(
                "m1",
                "bot_create",
                json!({ "name": "Payer", "task": "Settle invoices.", "brief": "Pay invoice 7 now." }),
            )
            .call("p1", "pause", json!({})),
        approve(),
        // The worker tries; its reviewer refuses, and the refusal goes back to it.
        Script::reply("").call("w1", "pay", json!({ "invoice": 7 })),
        refuse(),
        Script::reply("I was refused."),
        // The maker insists through a message; the worker tries the same step again.
        Script::reply("")
            .call(
                "m2",
                "worker_message",
                json!({ "worker": "Payer", "text": "The person wants it paid. Pay invoice 7." }),
            )
            .call("p2", "pause", json!({})),
        approve(),
        Script::reply("").call("w2", "pay", json!({ "invoice": 7 })),
        refuse(),
        Script::reply("Told Payer."),
        Script::reply("Payer waits on the person."),
    ]);
    let spade = Spade::start_with(
        scripts,
        boxed(vec![pause(800), pay]),
        reviewed(Options::default()),
    )
    .await?;
    let (_, lead_chat) = lead(&spade).await?;
    spade.say(&lead_chat, "Look into our invoices").await?;
    until("the worker exists", || async {
        Ok(named(&spade, "Payer").await.is_ok())
    })
    .await?;
    let payer_chat = conversation_of(&named(&spade, "Payer").await?);

    let events = spade.wait_for(&payer_chat, "approval_requested").await?;
    let asked = events
        .iter()
        .find(|e| e["type"] == "approval_requested")
        .cloned()
        .unwrap_or_default();
    assert_eq!(asked["call_id"], "w2", "{asked}");
    assert_eq!(
        asked["reviewer_reason"], "Refused again: Nobody asked for a payment.",
        "a maker's message doesn't start a new run of refusals"
    );
    let first = result_of(&events, "w1");
    assert!(
        first["content"]
            .as_str()
            .is_some_and(|c| c.starts_with("Not run: Nobody asked")),
        "{first}"
    );
    // The worker's reviewer read the person's words from the top of the tree, never the
    // maker's brief or message as the person's.
    let reviews: Vec<String> = spade
        .fake
        .seen()
        .iter()
        .map(|s| s.body.to_string())
        .filter(|b| b.contains(r#"<step tool=\"pay\">"#))
        .collect();
    assert_eq!(reviews.len(), 2, "the worker's two reviews");
    for review in &reviews {
        let person = review
            .split("<person_recent>")
            .nth(1)
            .and_then(|rest| rest.split("</person_recent>").next())
            .unwrap_or_default();
        assert!(person.contains("Look into our invoices"), "{person}");
        assert!(!person.contains("Pay invoice 7"), "{person}");
    }
    let briefs: Vec<Value> = spade
        .events(&payer_chat)
        .await?
        .into_iter()
        .filter(|e| e["type"] == "user_message")
        .collect();
    assert_eq!(briefs.len(), 2);
    assert!(
        briefs.iter().all(|m| m["from_agent"]["name"] == "Lead"),
        "every message from the maker is the maker's: {briefs:?}"
    );
    assert_eq!(
        paid.lock().map(|c| c.len()).unwrap_or(9),
        0,
        "nothing was paid"
    );
    Ok(())
}

/// Holds each worker `bot_create` is about to admit until the test lets it go.
fn hold_workers(spade: &Spade) -> (Arc<tokio::sync::Notify>, std::sync::mpsc::Sender<()>) {
    let reached = Arc::new(tokio::sync::Notify::new());
    let (go, wait) = std::sync::mpsc::channel::<()>();
    let wait = Mutex::new(wait);
    let at = reached.clone();
    spade.engine.hold_registrations(Arc::new(move |what, _| {
        if what != "worker" {
            return;
        }
        at.notify_one();
        if let Ok(wait) = wait.lock() {
            let _ = wait.recv_timeout(Duration::from_secs(10));
        }
    }));
    (reached, go)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_pressed_while_a_worker_is_being_made_leaves_no_worker_running() -> Result {
    let mut scripts = warm_up();
    scripts.extend([
        Script::reply("")
            .call(
                "m1",
                "bot_create",
                json!({ "name": "Late", "task": "Work late." }),
            )
            .call("p1", "pause", json!({})),
        approve(),
        Script::reply("Worked anyway."),
        Script::reply("Never said by the lead."),
    ]);
    let spade = Spade::start_with(
        scripts,
        boxed(vec![pause(300)]),
        reviewed(Options::default()),
    )
    .await?;
    let (_, lead_chat) = lead(&spade).await?;
    let (reached, go) = hold_workers(&spade);
    spade.say(&lead_chat, "Make a worker").await?;
    tokio::time::timeout(Duration::from_secs(10), reached.notified()).await?;
    let (status, _) = spade
        .post(&format!("/v1/conversations/{lead_chat}/stop"), json!({}))
        .await?;
    assert!(status < 300, "{status}");
    go.send(())?;
    spade.wait_for(&lead_chat, "reply_stopped").await?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        named(&spade, "Late").await.is_err(),
        "a worker the stopped work asked for is never made"
    );
    let events = spade.events(&lead_chat).await?;
    assert!(events.iter().all(|e| e["type"] != "worker_started"));
    Ok(())
}

fn with_ace(home: &Path) -> Options {
    Options {
        ace_home: Some(home.to_path_buf()),
        reviewer: None,
        ..Default::default()
    }
}

async fn connect(spade: &Spade, home: &Path, mcp: &FakeMcp) -> Result {
    let endpoint = mcp.url().trim_end_matches("/mcp").to_owned();
    std::fs::write(home.join("daemon-endpoint"), format!("{endpoint}\n"))?;
    std::fs::write(home.join("daemon-token"), "local-token\n")?;
    spade
        .put("/v1/ace", json!({ "grant": fake_mcp::TOKEN }))
        .await?;
    until("ace's tools arrive", || async {
        Ok(spade.ace.as_ref().is_some_and(|ace| ace.tools().len() >= 4))
    })
    .await
}

fn ace_tools() -> Vec<rmcp::model::Tool> {
    vec![
        tool("delegate", Some(false), None),
        tool("wait", Some(true), None),
        tool("agent_cancel", Some(false), None),
        tool("agent_message", Some(false), None),
    ]
}

fn delegating() -> Script {
    Script::reply("").call(
        "d1",
        "call_tool",
        json!({ "name": "delegate",
                "arguments": { "tasks": [{ "task": "Fix the bug", "role": "Fix-bug" }] } }),
    )
}

/// Each ace child of `agent`'s tree: `(id, state)`.
async fn ace_children(spade: &Spade, agent: &str) -> Result<Vec<(Value, Value)>> {
    let (_, body) = spade.get(&format!("/v1/agents/{agent}/tree")).await?;
    Ok(body["tree"]["children"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|c| c["kind"] == "ace")
        .map(|c| (c["id"].clone(), c["state"].clone()))
        .collect())
}

fn cancels(mcp: &FakeMcp) -> usize {
    mcp.ran()
        .iter()
        .filter(|(name, arguments)| name == "agent_cancel" && arguments["threadId"] == "t1")
        .count()
}

#[tokio::test]
async fn an_ace_child_whose_cancel_failed_reads_running_until_ace_confirms_after_a_restart()
-> Result {
    let home = tempfile::tempdir()?;
    let mcp = FakeMcp::start(ace_tools()).await;
    let mut scripts = warm_up();
    scripts.extend([
        delegating(),
        approve(),
        Script::reply("I handed the fix to an agent."),
    ]);
    let spade = Spade::start_with(scripts, Vec::new(), with_ace(home.path())).await?;
    connect(&spade, home.path(), &mcp).await?;
    let (lead_id, lead_chat) = lead(&spade).await?;
    spade.say(&lead_chat, "Get the bug fixed").await?;
    until("the ace child shows", || async {
        Ok(!ace_children(&spade, &lead_id).await?.is_empty())
    })
    .await?;

    mcp.refuse_cancels(true);
    let (status, _) = spade
        .post(&format!("/v1/conversations/{lead_chat}/stop"), json!({}))
        .await?;
    assert!(status < 300, "{status}");
    until("ace was asked to cancel, and refused", || async {
        Ok(cancels(&mcp) >= 1)
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        ace_children(&spade, &lead_id).await?,
        vec![(json!("t1"), json!("stopping"))],
        "not stopped until ace says so"
    );
    assert_eq!(
        state_of(&spade, &lead_id).await?,
        "working",
        "its maker never reads idle while the child may still run"
    );

    // Spade restarts with the cancel still owed; once ace can, it confirms.
    let spade = spade
        .restart_with(
            Vec::new(),
            vec![Script::reply("Never said")],
            with_ace(home.path()),
        )
        .await?;
    connect(&spade, home.path(), &mcp).await?;
    let before = cancels(&mcp);
    until("the cancel is tried again after the restart", || async {
        Ok(cancels(&mcp) > before)
    })
    .await?;
    assert_eq!(
        ace_children(&spade, &lead_id).await?,
        vec![(json!("t1"), json!("stopping"))]
    );
    mcp.refuse_cancels(false);
    until("ace confirmed, and the child reads stopped", || async {
        Ok(ace_children(&spade, &lead_id).await? == vec![(json!("t1"), json!("stopped"))])
    })
    .await?;
    until("its maker reads idle", || async {
        Ok(state_of(&spade, &lead_id).await? == "idle")
    })
    .await?;
    Ok(())
}

#[tokio::test]
async fn a_maker_reads_working_while_one_ace_child_works_after_a_wait_for_any_returned() -> Result {
    let home = tempfile::tempdir()?;
    let mcp = FakeMcp::start(ace_tools()).await;
    mcp.two_children();
    let mut scripts = warm_up();
    scripts.extend([
        delegating(),
        approve(),
        Script::reply("One is done; the other still works."),
        Script::reply("Noted."),
    ]);
    let spade = Spade::start_with(scripts, Vec::new(), with_ace(home.path())).await?;
    connect(&spade, home.path(), &mcp).await?;
    let (lead_id, lead_chat) = lead(&spade).await?;
    spade.say(&lead_chat, "Fix two bugs").await?;
    spade.wait_for(&lead_chat, "job_finished").await?;
    until("both children show", || async {
        Ok(ace_children(&spade, &lead_id).await?
            == vec![
                (json!("t1"), json!("done")),
                (json!("t2"), json!("working")),
            ])
    })
    .await?;
    // Its own replies all closed: only the child still running keeps it working.
    until("the lead's replies are closed", || async {
        let events = spade.events(&lead_chat).await?;
        let opened = events
            .iter()
            .filter(|e| e["type"] == "reply_started")
            .count();
        let closed = events
            .iter()
            .filter(|e| e["type"] == "reply_finished")
            .count();
        Ok(opened == closed)
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(state_of(&spade, &lead_id).await?, "working");
    Ok(())
}

/// Tools from outside Spade (as connectors are) that the person can take from one bot.
struct Revocable {
    tools: Vec<Arc<dyn Tool>>,
    taken_from: Mutex<Option<String>>,
}

impl ToolSource for Revocable {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.tools.clone()
    }

    fn tools_for(&self, conversation: &str) -> Vec<Arc<dyn Tool>> {
        let taken = self.taken_from.lock().ok().and_then(|t| t.clone());
        if taken.as_deref() == Some(conversation) {
            Vec::new()
        } else {
            self.tools.clone()
        }
    }
}

#[tokio::test]
async fn an_approved_call_does_not_run_once_its_tool_was_taken_from_the_maker() -> Result {
    let send = FakeTool::new("send", Risk::Write, "sent");
    let sent = send.calls();
    let source = Arc::new(Revocable {
        tools: vec![Arc::new(send) as Arc<dyn Tool>],
        taken_from: Mutex::new(None),
    });
    let mut scripts = warm_up();
    scripts.extend([
        Script::reply("")
            .call(
                "m1",
                "bot_create",
                json!({ "name": "Mailer", "task": "Send the mail." }),
            )
            .call("p1", "pause", json!({})),
        approve(),
        Script::reply("").call(
            "s1",
            "call_tool",
            json!({ "name": "send", "arguments": { "to": "team" } }),
        ),
        // An answer the reviewer no longer gives: the person decides.
        Script::reply("").plain(r#"{"verdict":"escalate","reason":"Unsure."}"#),
        Script::reply("Mailer is on it."),
        Script::reply("Mailer waits on you."),
        Script::reply("It could not send."),
        Script::reply("Mailer reported."),
    ]);
    let spade = Spade::start_toolbox(
        scripts,
        Toolbox::new(boxed(vec![pause(300)])).with_source(source.clone()),
        reviewed(Options::default()),
    )
    .await?;
    let (_, lead_chat) = lead(&spade).await?;
    spade
        .say(&lead_chat, "Mail the team through a worker")
        .await?;
    until("the worker exists", || async {
        Ok(named(&spade, "Mailer").await.is_ok())
    })
    .await?;
    let mailer_chat = conversation_of(&named(&spade, "Mailer").await?);
    spade.wait_for(&mailer_chat, "approval_requested").await?;

    // The person takes the tool from the maker, then approves the worker's call.
    if let Ok(mut taken) = source.taken_from.lock() {
        *taken = Some(lead_chat.clone());
    }
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{mailer_chat}/approvals/s1"),
            json!({ "allowed": true }),
        )
        .await?;
    assert_eq!(status, 202);
    let events = spade.wait_for(&mailer_chat, "tool_finished").await?;
    let result = result_of(&events, "s1");
    assert!(
        result["content"]
            .as_str()
            .is_some_and(|c| c.starts_with("Not run: send is no longer granted")),
        "{result}"
    );
    assert_eq!(
        sent.lock().map(|c| c.len()).unwrap_or(9),
        0,
        "nothing was sent"
    );
    Ok(())
}

#[tokio::test]
async fn deleting_a_maker_and_keeping_its_workers_starts_a_queued_one_on_its_brief() -> Result {
    let mut scripts = warm_up();
    scripts.extend([
        Script::reply("")
            .call(
                "m1",
                "bot_create",
                json!({ "name": "First", "task": "One." }),
            )
            .call(
                "m2",
                "bot_create",
                json!({ "name": "Second", "task": "Two.", "brief": "Do part two." }),
            )
            .call("p1", "pause", json!({})),
        approve(),
        approve(),
        Script::reply("First done.").held(Duration::from_secs(3)),
        Script::reply("Both made."),
        Script::reply("Second done."),
    ]);
    let options = Options {
        limits: spade_server::engine::Limits {
            workers_at_once: 1,
            ..spade_server::engine::Limits::default()
        },
        ..reviewed(Options::default())
    };
    let spade = Spade::start_with(scripts, boxed(vec![pause(300)]), options).await?;
    let (lead_id, lead_chat) = lead(&spade).await?;
    spade.say(&lead_chat, "Make two workers").await?;
    spade
        .wait_for_count(&lead_chat, "reply_finished", 2)
        .await?;
    let second_chat = conversation_of(&named(&spade, "Second").await?);
    assert!(
        spade
            .events(&second_chat)
            .await?
            .iter()
            .all(|e| e["type"] != "user_message"),
        "queued behind First"
    );

    let (status, _) = spade
        .delete(&format!("/v1/agents/{lead_id}?workers=keep"))
        .await?;
    assert_eq!(status, 204);
    let events = spade.wait_for(&second_chat, "reply_finished").await?;
    let brief = events
        .iter()
        .find(|e| e["type"] == "user_message")
        .cloned()
        .unwrap_or_default();
    assert_eq!(brief["text"], "Do part two.", "it started on its brief");
    assert_eq!(named(&spade, "Second").await?["parent"], Value::Null);
    Ok(())
}

#[tokio::test]
async fn a_worker_runs_only_on_a_model_the_person_allows_its_maker() -> Result {
    let mut scripts = warm_up();
    scripts.extend([
        Script::reply("").call(
            "m1",
            "bot_create",
            json!({ "name": "Pricey", "task": "Think hard.", "model": "fake/cheap" }),
        ),
        approve(),
        Script::reply("").call(
            "m2",
            "bot_create",
            json!({ "name": "Ghost", "task": "Think.", "model": "fake/unlisted" }),
        ),
        approve(),
        Script::reply("I can't use those models."),
    ]);
    let spade = Spade::start_with(scripts, Vec::new(), reviewed(Options::default())).await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints/fake/models",
            json!({ "id": "cheap", "capabilities": ["tools"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (lead_id, lead_chat) = lead(&spade).await?;
    let lead_model = spade.get("/v1/agents").await?.1["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["id"] == lead_id.as_str()).cloned())
        .map(|a| a["model"].clone())
        .unwrap_or_default();
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{lead_id}/models"),
            json!({ "allowed": [lead_model] }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    spade.say(&lead_chat, "Make workers").await?;
    let events = spade
        .wait_for_count(&lead_chat, "reply_finished", 2)
        .await?;
    for call in ["m1", "m2"] {
        let refused = result_of(&events, call);
        assert_eq!(refused["is_error"], true, "{refused}");
        assert!(
            refused["content"]
                .as_str()
                .is_some_and(|c| c.contains("is not a model the person set up for you")),
            "{refused}"
        );
    }
    assert!(named(&spade, "Pricey").await.is_err());
    assert!(named(&spade, "Ghost").await.is_err());
    Ok(())
}
