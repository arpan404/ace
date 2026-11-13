//! Access levels, the auto-review and tasks that keep going (ADR 0144), through the API with a
//! real database and a scripted fake model. Every model, reviewer included, is the fake.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::engine::Limits;
use spade_server::tools::{TaskStatus, Tool};
use spade_testkit::Script;
use support::{FakeTool, Options, Result, Spade};

const TITLE: &str = r#"{"title":"Work"}"#;

/// A bot on `access`, and its conversation.
async fn bot(spade: &Spade, access: &str) -> Result<(String, String)> {
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Builder", "task": "Keep the build green", "model": "fake/m",
                    "access": access }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["agent"]["access"], access);
    let agent = &body["agent"];
    Ok((
        agent["id"].as_str().unwrap_or_default().to_owned(),
        agent["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    ))
}

/// Waits until the conversation has no open reply and nothing waits to start.
async fn settled(spade: &Spade, conversation: &str) -> Result<Vec<Value>> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let events = spade.events(conversation).await?;
        let started = count(&events, "reply_started");
        let ended = events
            .iter()
            .filter(|e| {
                matches!(
                    e["type"].as_str(),
                    Some("reply_finished" | "reply_stopped" | "reply_failed")
                )
            })
            .count();
        let agent = roster_entry(spade, conversation).await?;
        if started > 0 && started == ended && agent["continuing"] == false {
            return Ok(events);
        }
        if Instant::now() > deadline {
            return Err(format!("never settled: {events:?}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn roster_entry(spade: &Spade, conversation: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    body["agents"]
        .as_array()
        .and_then(|l| {
            l.iter()
                .find(|a| a["conversation"] == conversation)
                .cloned()
        })
        .ok_or_else(|| "the bot is not in the roster".into())
}

async fn patch(spade: &Spade, agent: &str, body: Value) -> Result<(u16, Value)> {
    let response = spade
        .http
        .patch(format!("{}/v1/agents/{agent}", spade.base))
        .bearer_auth(support::TOKEN)
        .json(&body)
        .send()
        .await?;
    let status = response.status().as_u16();
    Ok((status, response.json().await.unwrap_or(Value::Null)))
}

fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

fn first<'a>(events: &'a [Value], kind: &str) -> Option<&'a Value> {
    events.iter().find(|e| e["type"] == kind)
}

fn shell() -> FakeTool {
    FakeTool::new("shell", Risk::Write, "exit 0")
}

fn calls_of(tool: &FakeTool) -> Arc<std::sync::Mutex<Vec<Value>>> {
    tool.calls()
}

fn ran(calls: &Arc<std::sync::Mutex<Vec<Value>>>) -> usize {
    calls.lock().map(|c| c.len()).unwrap_or(0)
}

#[tokio::test]
async fn auto_review_approves_a_workspace_command_without_asking_the_person() -> Result {
    let tool = shell();
    let commands = calls_of(&tool);
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "shell", json!({ "command": "cargo test" })),
            Script::reply("").plain(
                r#"{"verdict":"approve","reason":"Runs the tests in its folder.","outward_or_irreversible":false}"#,
            ),
            Script::reply("Tests pass."),
            Script::reply("").plain(TITLE),
        ],
        vec![Arc::new(tool) as Arc<dyn Tool>],
    )
    .await?;
    let (agent, conversation) = bot(&spade, "auto_review").await?;
    spade.say(&conversation, "Run the tests").await?;
    let events = settled(&spade, &conversation).await?;
    assert_eq!(count(&events, "approval_requested"), 0, "{events:?}");
    let verdict = first(&events, "call_reviewed").ok_or("no verdict")?;
    assert_eq!(verdict["verdict"], "allow");
    assert_eq!(ran(&commands), 1);
    // The reviewer read the call and where it runs.
    let review = spade.fake.seen()[1].body.to_string();
    assert!(review.contains("cargo test") && review.contains("workspace"));
    // Its verdict is in the activity log.
    let (_, log) = spade
        .get(&format!("/v1/agents/{agent}/activity?kind=review"))
        .await?;
    assert_eq!(log["entries"][0]["outcome"], "allowed");
    Ok(())
}

#[tokio::test]
async fn a_refusal_reaches_the_bot_as_a_result_with_the_reason_and_nothing_runs() -> Result {
    let tool = shell();
    let commands = calls_of(&tool);
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "shell", json!({ "command": "rm -rf tests" })),
            Script::reply("").plain(
                r#"{"verdict":"refuse","reason":"That deletes the tests the person wants kept."}"#,
            ),
            Script::reply("Understood, I'll leave the tests."),
            Script::reply("").plain(TITLE),
        ],
        vec![Arc::new(tool) as Arc<dyn Tool>],
    )
    .await?;
    let (_, conversation) = bot(&spade, "auto_review").await?;
    spade.say(&conversation, "Tidy up").await?;
    let events = settled(&spade, &conversation).await?;
    assert_eq!(ran(&commands), 0);
    assert_eq!(count(&events, "approval_requested"), 0);
    let result = first(&events, "tool_finished").ok_or("no result")?;
    assert_eq!(result["is_error"], false, "a refusal is no failure");
    let content = result["content"].as_str().unwrap_or("");
    assert!(
        content.starts_with("Not run: That deletes the tests"),
        "{content}"
    );
    // The model's next step read it.
    assert!(
        spade.fake.seen()[2]
            .body
            .to_string()
            .contains("Not run: That deletes the tests")
    );
    Ok(())
}

#[tokio::test]
async fn sending_email_as_the_person_always_goes_to_them_with_the_reason() -> Result {
    let send = FakeTool::new("send_email", Risk::Write, "Sent").app("Mail: Sends an email");
    let sent = calls_of(&send);
    let spade = Spade::start(
        vec![Script::reply("").call("c1", "send_email", json!({ "to": "sam@example.com" }))],
        vec![Arc::new(send) as Arc<dyn Tool>],
    )
    .await?;
    let (_, conversation) = bot(&spade, "auto_review").await?;
    spade.say(&conversation, "Email Sam").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    let asked = first(&events, "approval_requested").ok_or("not asked")?;
    assert_eq!(
        asked["reviewer_reason"],
        "It sends a message as you, so you decide."
    );
    let verdict = first(&events, "call_reviewed").ok_or("no verdict")?;
    assert_eq!(verdict["verdict"], "escalate");
    assert_eq!(spade.fake.seen().len(), 1, "no reviewer was asked");
    assert_eq!(ran(&sent), 0);
    Ok(())
}

#[tokio::test]
async fn a_reviewer_that_takes_too_long_leaves_the_call_to_the_person() -> Result {
    let tool = shell();
    let commands = calls_of(&tool);
    let options = Options {
        limits: Limits {
            review_timeout: Duration::ZERO,
            ..Limits::default()
        },
        ..Options::default()
    };
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("c1", "shell", json!({ "command": "make" })),
            Script::reply("").plain(r#"{"verdict":"approve","reason":"fine"}"#),
        ],
        vec![Arc::new(tool) as Arc<dyn Tool>],
        options,
    )
    .await?;
    let (_, conversation) = bot(&spade, "auto_review").await?;
    spade.say(&conversation, "Build it").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    let asked = first(&events, "approval_requested").ok_or("not asked")?;
    assert_eq!(
        asked["reviewer_reason"],
        "The review took too long, so you decide."
    );
    assert_eq!(ran(&commands), 0);
    Ok(())
}

#[tokio::test]
async fn full_access_runs_a_command_with_nothing_asked() -> Result {
    let tool = shell();
    let commands = calls_of(&tool);
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "shell", json!({ "command": "git status" })),
            Script::reply("Clean."),
            Script::reply("").plain(TITLE),
        ],
        vec![Arc::new(tool) as Arc<dyn Tool>],
    )
    .await?;
    let (_, conversation) = bot(&spade, "full_access").await?;
    spade.say(&conversation, "Check the tree").await?;
    let events = settled(&spade, &conversation).await?;
    assert_eq!(count(&events, "approval_requested"), 0);
    assert_eq!(count(&events, "call_reviewed"), 0);
    assert_eq!(ran(&commands), 1);
    assert_eq!(
        spade.fake.seen().len(),
        3,
        "two steps and a title, no review"
    );
    Ok(())
}

#[tokio::test]
async fn no_level_lets_a_bot_read_sign_in_tokens() -> Result {
    let tool = shell();
    let commands = calls_of(&tool);
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "c1",
                "shell",
                json!({ "command": "cat ~/.codex/auth.json" }),
            ),
            Script::reply("I can't read that."),
            Script::reply("").plain(TITLE),
        ],
        vec![Arc::new(tool) as Arc<dyn Tool>],
    )
    .await?;
    let (_, conversation) = bot(&spade, "full_access").await?;
    spade.say(&conversation, "Show me the Codex login").await?;
    let events = settled(&spade, &conversation).await?;
    assert_eq!(ran(&commands), 0);
    let result = first(&events, "tool_finished").ok_or("no result")?;
    assert!(
        result["content"]
            .as_str()
            .is_some_and(|c| c.contains("never lets a bot read sign-in tokens"))
    );
    Ok(())
}

#[tokio::test]
async fn on_ask_the_person_is_asked_as_before_with_no_reviewer() -> Result {
    let tool = shell();
    let spade = Spade::start(
        vec![Script::reply("").call("c1", "shell", json!({ "command": "ls" }))],
        vec![Arc::new(tool) as Arc<dyn Tool>],
    )
    .await?;
    let (_, conversation) = bot(&spade, "ask").await?;
    spade.say(&conversation, "List the files").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    let asked = first(&events, "approval_requested").ok_or("not asked")?;
    assert!(asked.get("reviewer_reason").is_none());
    assert_eq!(count(&events, "call_reviewed"), 0);
    assert_eq!(spade.fake.seen().len(), 1);
    Ok(())
}

/// A bot an earlier Spade made, before access levels: no level is stored for it.
fn older_bot(store: &spade_store::Store) -> spade_store::Result<()> {
    store.create_agent(
        spade_store::NewAgent {
            id: "a-old",
            kind: "bot",
            name: "Old",
            task: "",
            avatar: r#"{"kind":"spade"}"#,
            model: "fake/m",
            conversation: "c-old",
        },
        &[],
        0,
    )
}

#[tokio::test]
async fn a_new_bot_starts_on_auto_review_and_one_made_before_levels_is_on_ask() -> Result {
    let options = Options {
        new_bot_access: spade_core::autonomy::Access::AutoReview,
        seed: Some(older_bot),
        ..Options::default()
    };
    let spade = Spade::start_with(vec![Script::reply("Hi")], Vec::new(), options).await?;
    let made = spade.new_agent("Fresh", "").await?;
    assert_eq!(made["access"], "auto_review");
    assert_eq!(roster_entry(&spade, "c-old").await?["access"], "ask");
    // Spade itself, made by this build, is a bot like the others.
    let (_, roster) = spade.get("/v1/agents").await?;
    let main = roster["agents"]
        .as_array()
        .and_then(|l| l.iter().find(|a| a["kind"] == "main").cloned())
        .ok_or("no Spade")?;
    assert_eq!(main["access"], "auto_review");
    let (status, refused) = patch(
        &spade,
        made["id"].as_str().unwrap_or(""),
        json!({ "access": "everything" }),
    )
    .await?;
    assert_eq!(status, 400, "{refused}");
    Ok(())
}

#[tokio::test]
async fn a_level_change_survives_a_restart() -> Result {
    let spade = Spade::start(vec![Script::reply("Hi")], Vec::new()).await?;
    let (agent, conversation) = bot(&spade, "ask").await?;
    let (status, changed) = patch(&spade, &agent, json!({ "access": "full_access" })).await?;
    assert_eq!(status, 200, "{changed}");
    assert_eq!(changed["agent"]["access"], "full_access");
    let tool = shell();
    let commands = calls_of(&tool);
    let spade = spade
        .restart(
            vec![Arc::new(tool) as Arc<dyn Tool>],
            vec![
                Script::reply("").call("c1", "shell", json!({ "command": "make" })),
                Script::reply("Built."),
                Script::reply("").plain(TITLE),
            ],
        )
        .await?;
    assert_eq!(
        roster_entry(&spade, &conversation).await?["access"],
        "full_access"
    );
    spade.say(&conversation, "Build it").await?;
    let events = settled(&spade, &conversation).await?;
    assert_eq!(count(&events, "approval_requested"), 0);
    assert_eq!(ran(&commands), 1);
    // The change is in the activity log.
    let (_, log) = spade
        .get(&format!("/v1/agents/{agent}/activity?kind=access"))
        .await?;
    assert_eq!(log["entries"][0]["name"], "full_access");
    Ok(())
}

fn task_tools(shell: FakeTool) -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(shell), Arc::new(TaskStatus)]
}

#[tokio::test]
async fn a_bot_with_an_open_task_keeps_going_after_its_reply_until_it_marks_it_done() -> Result {
    let tool = shell();
    let commands = calls_of(&tool);
    let spade = Spade::start(
        vec![
            Script::reply("")
                .call(
                    "c1",
                    "task_status",
                    json!({ "status": "working", "note": "porting" }),
                )
                .call("c2", "shell", json!({ "command": "port one" })),
            Script::reply("Started on the port."),
            Script::reply("").plain(TITLE),
            // Spade's own next step: no message from the person.
            Script::reply("").call("c3", "shell", json!({ "command": "port two" })),
            Script::reply("").call("c4", "task_status", json!({ "status": "done" })),
            Script::reply("The port is done."),
        ],
        task_tools(tool),
    )
    .await?;
    let (_, conversation) = bot(&spade, "full_access").await?;
    spade.say(&conversation, "Port the tests").await?;
    let events = settled(&spade, &conversation).await?;
    assert_eq!(count(&events, "task_continued"), 1, "{events:?}");
    assert_eq!(ran(&commands), 2);
    let last = events
        .iter()
        .rev()
        .find(|e| e["type"] == "reply_finished")
        .ok_or("no reply")?;
    assert_eq!(last["text"], "The port is done.");
    // The model read Spade's note, not a message from the person.
    let continued = spade.fake.seen()[3].body.to_string();
    assert!(continued.contains("continue step="), "{continued}");
    let agent = roster_entry(&spade, &conversation).await?;
    assert_eq!(agent["task_state"]["status"], "done");
    assert_eq!(agent["continuing"], false);
    Ok(())
}

#[tokio::test]
async fn steps_that_change_nothing_pause_the_task_and_say_so() -> Result {
    let options = Options {
        limits: Limits {
            task: spade_core::task::Policy {
                idle_limit: 2,
                backoff_ms: 20,
                ..spade_core::task::Policy::default()
            },
            ..Limits::default()
        },
        ..Options::default()
    };
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("c1", "task_status", json!({ "status": "working" })),
            Script::reply("On it."),
            Script::reply("").plain(TITLE),
            Script::reply("Still thinking about it."),
        ],
        task_tools(shell()),
        options,
    )
    .await?;
    let (agent, conversation) = bot(&spade, "full_access").await?;
    spade.say(&conversation, "Sort out the build").await?;
    let events = spade.wait_for(&conversation, "task_paused").await?;
    let paused = first(&events, "task_paused").ok_or("not paused")?;
    assert_eq!(paused["reason"], "no_progress");
    assert_eq!(count(&events, "task_continued"), 2);
    let events = settled(&spade, &conversation).await?;
    assert_eq!(
        count(&events, "task_continued"),
        2,
        "nothing after the pause"
    );
    let (_, log) = spade
        .get(&format!("/v1/agents/{agent}/activity?kind=task"))
        .await?;
    assert_eq!(log["entries"][0]["name"], "paused");
    Ok(())
}

#[tokio::test]
async fn stop_ends_a_task_spade_was_carrying_on() -> Result {
    let slow = FakeTool::new("lookup", Risk::Read, "found").slow(Duration::from_secs(5));
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "task_status", json!({ "status": "working" })),
            Script::reply("On it."),
            Script::reply("").plain(TITLE),
            Script::reply("").call("c2", "lookup", json!({})),
        ],
        vec![Arc::new(slow) as Arc<dyn Tool>, Arc::new(TaskStatus)],
    )
    .await?;
    let (_, conversation) = bot(&spade, "full_access").await?;
    spade.say(&conversation, "Find the flaky test").await?;
    spade.wait_for(&conversation, "task_continued").await?;
    spade.wait_for(&conversation, "tool_started").await?;
    let (status, body) = spade
        .post(&format!("/v1/conversations/{conversation}/stop"), json!({}))
        .await?;
    assert!(status < 300, "{body}");
    let events = settled(&spade, &conversation).await?;
    assert_eq!(count(&events, "reply_stopped"), 1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let events = spade.events(&conversation).await?;
    assert_eq!(count(&events, "task_continued"), 1, "no step after Stop");
    Ok(())
}
