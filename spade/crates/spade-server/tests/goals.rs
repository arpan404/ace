//! A task's goal, plan and the separate check of done (ADR 0159), through the API with a real
//! database and a scripted fake model. Every model, the verifier included, is the fake.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::tools::{TaskGoal, TaskPlan, TaskStatus, Tool};
use spade_testkit::Script;
use support::{FakeTool, Result, Spade};

const TITLE: &str = r#"{"title":"Work"}"#;
const VERIFIER: &str = "You check whether a task is done";

fn tools() -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(FakeTool::new(
            "run_tests",
            Risk::Read,
            "test result: ok. 2 passed",
        )),
        Arc::new(FakeTool::new("run_lint", Risk::Read, "lint: 0 warnings")),
        Arc::new(TaskStatus),
        Arc::new(TaskGoal),
        Arc::new(TaskPlan),
    ]
}

async fn bot(spade: &Spade) -> Result<(String, String)> {
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Builder", "task": "Keep the build green", "model": "fake/m",
                    "access": "full_access" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let agent = &body["agent"];
    Ok((
        agent["id"].as_str().unwrap_or_default().to_owned(),
        agent["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    ))
}

fn of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == kind).collect()
}

/// Waits until the conversation has `count` events of `kind` and nothing more is starting.
async fn settled_with(
    spade: &Spade,
    conversation: &str,
    kind: &str,
    count: usize,
) -> Result<Vec<Value>> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let events = spade.events(conversation).await?;
        let started = of_type(&events, "reply_started").len();
        let ended = of_type(&events, "reply_finished").len();
        let (_, roster) = spade.get("/v1/agents").await?;
        let continuing = roster["agents"]
            .as_array()
            .and_then(|l| l.iter().find(|a| a["conversation"] == conversation))
            .is_some_and(|a| a["continuing"] == true);
        if of_type(&events, kind).len() >= count && started == ended && !continuing {
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

/// The requests the verifier was sent.
fn verifier_requests(spade: &Spade) -> Vec<String> {
    spade
        .fake
        .seen()
        .iter()
        .map(|s| s.body.to_string())
        .filter(|b| b.contains(VERIFIER))
        .collect()
}

#[tokio::test]
async fn a_claim_of_done_is_checked_against_the_evidence_and_not_yet_sends_the_bot_back() -> Result
{
    let spade = Spade::start(
        vec![
            Script::reply("")
                .call(
                    "c1",
                    "task_goal",
                    json!({ "title": "Green build", "criteria": ["tests pass", "lint is clean"] }),
                )
                .call("c2", "task_status", json!({ "status": "working" })),
            Script::reply("").call("c3", "task_plan", json!({ "op": "add", "text": "fix the test" })),
            Script::reply("").call("c4", "run_tests", json!({})),
            Script::reply("")
                .call(
                    "c5",
                    "task_plan",
                    json!({ "op": "done", "item": "1",
                            "evidence": [{ "kind": "output", "call": "c4" }] }),
                )
                .call("c6", "task_status", json!({ "status": "done" })),
            Script::reply("Everything is fixed and perfect."),
            Script::reply("").plain(TITLE),
            // The verifier: the tests are shown, the lint isn't.
            Script::reply("").plain(
                r#"{"criteria":[{"id":"1","met":true,"why":"2 passed"},{"id":"2","met":false,"why":"no lint run"}],"missing":["Show the lint passing."],"done":false}"#,
            ),
            // Back to work, on Spade's note.
            Script::reply("").call("c7", "run_lint", json!({})),
            Script::reply("").call("c8", "task_plan", json!({ "op": "add", "text": "run the lint" })),
            Script::reply("")
                .call(
                    "c9",
                    "task_plan",
                    json!({ "op": "done", "item": "2",
                            "evidence": [{ "kind": "output", "call": "c7" }] }),
                )
                .call("c10", "task_status", json!({ "status": "done" })),
            Script::reply("The lint is clean too."),
            Script::reply("").plain(
                r#"{"criteria":[{"id":"1","met":true,"why":"2 passed"},{"id":"2","met":true,"why":"0 warnings"}],"done":true}"#,
            ),
        ],
        tools(),
    )
    .await?;
    let (agent, conversation) = bot(&spade).await?;
    spade.say(&conversation, "Make the build green").await?;
    let events = settled_with(&spade, &conversation, "task_verified", 2).await?;
    let verdicts: Vec<&Value> = of_type(&events, "task_verified");
    assert_eq!(verdicts[0]["verdict"], "not_yet", "{verdicts:?}");
    assert_eq!(verdicts[1]["verdict"], "done", "{verdicts:?}");
    // The bot went back to work on a note naming what was missing.
    let continued = of_type(&events, "task_continued");
    let nudges: Vec<&str> = continued
        .iter()
        .filter_map(|e| e["nudge"].as_str())
        .collect();
    assert!(
        nudges.iter().any(|n| n.contains("Show the lint passing.")),
        "{nudges:?}"
    );
    // The verifier read the tool's stored output and the person's words, never the bot's own.
    let checks = verifier_requests(&spade);
    assert_eq!(checks.len(), 2);
    assert!(checks[0].contains("test result: ok. 2 passed"));
    assert!(checks[0].contains("Make the build green"));
    assert!(!checks[0].contains("Everything is fixed and perfect."));
    let (status, body) = spade.get(&format!("/v1/agents/{agent}/task")).await?;
    assert_eq!(status, 200, "{body}");
    let task = &body["task"];
    assert_eq!(task["progress"]["state"], "done", "{task}");
    assert_eq!(task["progress"]["items_verified"], 2);
    assert_eq!(task["goal"]["text"], "Make the build green");
    assert_eq!(task["items"][0]["evidence"][0]["call"], "c4");
    assert_eq!(task["checkpoint"]["item"], "2");
    let shown = roster_entry(&spade, &conversation).await?;
    assert_eq!(shown["task_progress"]["state"], "done");
    Ok(())
}

#[tokio::test]
async fn only_the_person_changes_an_open_goal() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "c1",
                "task_goal",
                json!({ "title": "Blog move", "criteria": ["the blog answers on the new host"] }),
            ),
            Script::reply("").call(
                "c2",
                "task_goal",
                json!({ "title": "Easier", "criteria": ["something easy"] }),
            ),
            Script::reply("Working on it."),
            Script::reply("").plain(TITLE),
        ],
        tools(),
    )
    .await?;
    let (agent, conversation) = bot(&spade).await?;
    spade.say(&conversation, "Move the blog").await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let second = of_type(&events, "tool_finished")
        .into_iter()
        .find(|e| e["call_id"] == "c2")
        .ok_or("no result for the second goal")?;
    assert_eq!(second["is_error"], true);
    assert!(
        second["content"]
            .as_str()
            .is_some_and(|c| c.contains("only the person")),
        "{second}"
    );
    let path = format!("/v1/agents/{agent}/task/goal");
    let (status, body) = spade
        .put(
            &path,
            json!({ "title": "Blog move", "criteria": ["the blog answers on the new host",
                                                       "old links redirect"] }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["task"]["goal"]["by"], "person");
    assert_eq!(body["task"]["goal"]["text"], "Move the blog");
    assert_eq!(
        body["task"]["goal"]["criteria"][1]["text"],
        "old links redirect"
    );
    let (status, _) = spade
        .put(&path, json!({ "title": "x", "criteria": [] }))
        .await?;
    assert_eq!(status, 400);
    let (status, _) = spade.delete(&path).await?;
    assert_eq!(status, 204);
    let (_, body) = spade.get(&format!("/v1/agents/{agent}/task")).await?;
    assert_eq!(body["task"]["progress"]["state"], "none");
    let (status, _) = spade.delete(&path).await?;
    assert_eq!(status, 409);
    Ok(())
}

#[tokio::test]
async fn a_check_that_cannot_run_leaves_the_task_not_done_and_not_sent_back() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("")
                .call(
                    "c1",
                    "task_goal",
                    json!({ "title": "Tests", "criteria": ["tests pass"] }),
                )
                .call(
                    "c2",
                    "task_plan",
                    json!({ "op": "add", "text": "run them" }),
                ),
            Script::reply("").call("c3", "run_tests", json!({})),
            Script::reply("")
                .call(
                    "c4",
                    "task_plan",
                    json!({ "op": "done", "item": "1",
                            "evidence": [{ "kind": "output", "call": "c3" }] }),
                )
                .call("c5", "task_status", json!({ "status": "done" })),
            Script::reply("Done."),
            Script::reply("").plain(TITLE),
            Script::failing(400),
        ],
        tools(),
    )
    .await?;
    let (agent, conversation) = bot(&spade).await?;
    spade.say(&conversation, "Run the tests").await?;
    let events = settled_with(&spade, &conversation, "task_verified", 1).await?;
    let verdict = of_type(&events, "task_verified")[0];
    assert_eq!(verdict["verdict"], "unchecked", "{verdict}");
    assert!(of_type(&events, "task_continued").is_empty());
    let shown = roster_entry(&spade, &conversation).await?;
    assert_eq!(shown["task_state"]["status"], "done");
    assert_eq!(shown["task_progress"]["state"], "unchecked");
    let (_, body) = spade.get(&format!("/v1/agents/{agent}/task")).await?;
    assert_eq!(body["task"]["items"][0]["verified"], false);
    Ok(())
}

#[tokio::test]
async fn the_plan_rides_in_the_prompt_top_after_a_compaction() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("")
                .call(
                    "c1",
                    "task_goal",
                    json!({ "title": "Release", "criteria": ["the release is tagged"] }),
                )
                .call(
                    "c2",
                    "task_plan",
                    json!({ "op": "add", "text": "write the changelog" }),
                ),
            Script::reply("Planned."),
            Script::reply("").plain(TITLE),
            Script::reply("Second answer."),
            Script::reply("")
                .plain(r#"{"goal":"Ship","decisions":[],"facts":[],"open":[],"references":[]}"#),
            Script::reply("Third answer."),
        ],
        tools(),
    )
    .await?;
    let (_, conversation) = bot(&spade).await?;
    spade.say(&conversation, "Cut the release").await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    spade.say(&conversation, "And then?").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/compact"),
            json!({}),
        )
        .await?;
    assert!(status < 300, "{status} {body}");
    spade.say(&conversation, "Go on").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 3)
        .await?;
    let seen = spade.fake.seen();
    let last = seen.last().ok_or("no request")?.body.to_string();
    assert!(last.contains("write the changelog"), "{last}");
    assert!(last.contains("the release is tagged"), "{last}");
    assert!(last.contains("Cut the release"), "{last}");
    Ok(())
}
