//! Model roles (ADR 0162) through the real API with a scripted model: helpers run on the fast
//! model unless the bot names a role or a model the person configured, failed helper work
//! reruns once on the bot's own model, spend shows by role, and a step Spade starts on its own
//! tells the bot what it spent.
//!
//! Model calls take scripts in the order they arrive. A bot's step that starts helpers also calls
//! `pause`, so the helpers' calls arrive before the bot's next step.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::tools::{TaskStatus, Tool};
use spade_testkit::Script;
use support::{FakeTool, Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Logs"}"#)
}

fn pause() -> FakeTool {
    FakeTool::new("pause", Risk::Read, "ok").slow(Duration::from_millis(800))
}

fn tools(list: Vec<Arc<dyn Tool>>) -> Vec<Arc<dyn Tool>> {
    list
}

/// Adds the unpriced `fake/cheap` to the person's endpoint and makes it the fast model.
async fn cheap_fast_model(spade: &Spade) -> Result {
    let (status, body) = spade
        .post(
            "/v1/endpoints/fake/models",
            json!({ "id": "cheap", "capabilities": ["tools"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (status, body) = spade
        .put("/v1/settings", json!({ "fast_model": "fake/cheap" }))
        .await?;
    assert!(status < 300, "{body}");
    Ok(())
}

/// A bot on `fake/m` that has had its first turn: its id and conversation.
async fn warm_bot(spade: &Spade) -> Result<(String, String)> {
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Logs", "task": "", "model": "fake/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let agent = &body["agent"];
    let id = agent["id"].as_str().unwrap_or_default().to_owned();
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;
    Ok((id, conversation))
}

async fn helpers(spade: &Spade, conversation: &str) -> Result<Vec<Value>> {
    let (status, body) = spade
        .get(&format!("/v1/conversations/{conversation}/helpers"))
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["helpers"].as_array().cloned().unwrap_or_default())
}

/// Waits until `count` jobs have finished and no reply is open, and returns the events.
async fn settled(spade: &Spade, conversation: &str, jobs: usize) -> Result<Vec<Value>> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let events = spade.events(conversation).await?;
        if count(&events, "job_finished") >= jobs
            && count(&events, "reply_started") == count(&events, "reply_finished")
        {
            return Ok(events);
        }
        if Instant::now() > deadline {
            return Err(format!("never settled: {}", support::types(&events).join(", ")).into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

fn result_of<'a>(events: &'a [Value], job: &str) -> &'a Value {
    events
        .iter()
        .find(|e| e["type"] == "job_finished" && e["job"] == job)
        .unwrap_or(&Value::Null)
}

/// The model of the first request that carries `text`.
fn model_asked_with(spade: &Spade, text: &str) -> Option<String> {
    spade
        .fake
        .seen()
        .into_iter()
        .find(|seen| seen.body.to_string().contains(text))
        .and_then(|seen| seen.body["model"].as_str().map(str::to_owned))
}

fn helper_with_task<'a>(found: &'a [Value], task: &str) -> &'a Value {
    found
        .iter()
        .find(|h| h["task"] == task)
        .unwrap_or(&Value::Null)
}

#[tokio::test]
async fn helpers_run_on_the_fast_model_unless_the_bot_names_a_role_and_unknown_models_are_refused()
-> Result {
    let scripts = vec![
        Script::reply("Hello."),
        title(),
        Script::reply("")
            .call("h1", "helper", json!({ "task": "Read log A" }))
            .call(
                "h2",
                "helper",
                json!({ "task": "Decide what log B means", "model": "main" }),
            )
            .call(
                "h3",
                "helper",
                json!({ "task": "Read log C", "model": "openai/gpt-9" }),
            )
            .call("p1", "pause", json!({})),
        Script::reply("Log says step 3.").held(Duration::from_millis(1500)),
        Script::reply("Log says step 3.").held(Duration::from_millis(1500)),
        Script::reply("Two helpers are reading."),
        Script::reply("Both logs say step 3."),
    ];
    let spade = Spade::start(scripts, tools(vec![Arc::new(pause())])).await?;
    cheap_fast_model(&spade).await?;
    let (agent, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Why did CI fail?").await?;
    let events = settled(&spade, &conversation, 3).await?;

    let refused = result_of(&events, "h3");
    assert_eq!(refused["is_error"], true, "{refused}");
    let words = refused["content"].as_str().unwrap_or_default();
    assert!(
        words.contains("openai/gpt-9 is not a model the person set up for you")
            && words.contains("helper (fake/cheap)"),
        "{words}"
    );

    let found = helpers(&spade, &conversation).await?;
    assert_eq!(
        found.len(),
        2,
        "the refused helper never started: {found:?}"
    );
    assert_eq!(
        helper_with_task(&found, "Read log A")["model"],
        "fake/cheap"
    );
    assert_eq!(
        helper_with_task(&found, "Decide what log B means")["model"],
        "fake/m"
    );
    assert_eq!(
        model_asked_with(&spade, "Read log A").as_deref(),
        Some("cheap")
    );
    assert_eq!(
        model_asked_with(&spade, "Decide what log B means").as_deref(),
        Some("m")
    );

    // The helper on the bot's own (priced) model spent as `helper`, the bot's turns as `main`;
    // the unpriced fast model cost nothing. The API and the activity log agree.
    let (status, view) = spade.get(&format!("/v1/agents/{agent}/models")).await?;
    assert_eq!(status, 200, "{view}");
    let today = &view["spend"]["today"];
    assert!(today["helper"].as_u64().unwrap_or(0) > 0, "{view}");
    assert!(today["main"].as_u64().unwrap_or(0) > 0, "{view}");
    let (_, log) = spade.get(&format!("/v1/agents/{agent}/activity")).await?;
    assert_eq!(log["spend_by_role"]["today"], *today, "{log}");
    let spend = log["entries"]
        .as_array()
        .and_then(|entries| entries.iter().find(|e| e["kind"] == "spend"))
        .cloned()
        .unwrap_or_default();
    assert_eq!(spend["role"], "main", "{spend}");
    Ok(())
}

#[tokio::test]
async fn failed_helper_work_reruns_once_on_the_bots_own_model_when_escalation_is_on() -> Result {
    let scripts = vec![
        Script::reply("Hello."),
        title(),
        Script::reply("")
            .call("h1", "helper", json!({ "task": "Read the server log" }))
            .call("p1", "pause", json!({})),
        // The fast model refuses the request; the rerun on the bot's model answers.
        Script::failing(400),
        Script::reply("The disk is full.").held(Duration::from_millis(1500)),
        Script::reply("A helper is reading the log."),
        Script::reply("The disk is full."),
    ];
    let spade = Spade::start(scripts, tools(vec![Arc::new(pause())])).await?;
    cheap_fast_model(&spade).await?;
    let (agent, conversation) = warm_bot(&spade).await?;
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{agent}/models"),
            json!({ "escalate": true }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["escalate"], true);
    spade.say(&conversation, "What does the log say?").await?;
    let events = settled(&spade, &conversation, 1).await?;

    let result = result_of(&events, "h1");
    assert_eq!(result["is_error"], false, "{result}");
    assert_eq!(
        result["content"],
        "(The helper failed on fake/cheap, so it ran again on fake/m.)\n\nThe disk is full."
    );
    let found = helpers(&spade, &conversation).await?;
    let tries: Vec<(Value, Value)> = found
        .iter()
        .map(|h| (h["attempt"].clone(), h["model"].clone()))
        .collect();
    assert_eq!(
        tries,
        vec![(json!(1), json!("fake/cheap")), (json!(2), json!("fake/m"))]
    );
    assert_eq!(count(&events, "job_finished"), 1, "one result for the job");
    Ok(())
}

#[tokio::test]
async fn a_rerun_that_fails_too_ends_the_job_with_its_error_and_never_runs_a_third_time() -> Result
{
    let scripts = vec![
        Script::reply("Hello."),
        title(),
        Script::reply("")
            .call(
                "h1",
                "helper",
                json!({ "task": "Read the server log", "escalate": true }),
            )
            .call("p1", "pause", json!({})),
        Script::failing(400),
        Script::failing(400),
        Script::reply("A helper is reading the log."),
        Script::reply("The helper couldn't read it."),
    ];
    let spade = Spade::start(scripts, tools(vec![Arc::new(pause())])).await?;
    cheap_fast_model(&spade).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "What does the log say?").await?;
    let events = settled(&spade, &conversation, 1).await?;
    assert_eq!(result_of(&events, "h1")["is_error"], true);
    // Long enough for a third try to have started, had there been one.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(helpers(&spade, &conversation).await?.len(), 2);
    Ok(())
}

#[tokio::test]
async fn roles_follow_the_bots_choice_then_the_global_one_and_refuse_what_cannot_run() -> Result {
    let spade = Spade::start(vec![Script::reply("Hello."), title()], Vec::new()).await?;
    cheap_fast_model(&spade).await?;
    let (agent, _) = warm_bot(&spade).await?;
    let path = format!("/v1/agents/{agent}/models");
    let role = |view: &Value, name: &str| {
        view["roles"]
            .as_array()
            .and_then(|roles| roles.iter().find(|r| r["role"] == name).cloned())
            .unwrap_or_default()
    };

    let (_, view) = spade.get(&path).await?;
    assert_eq!(
        role(&view, "main"),
        json!({"role": "main", "model": "fake/m", "source": "own"})
    );
    assert_eq!(role(&view, "helper")["model"], "fake/cheap");
    assert_eq!(role(&view, "helper")["source"], "default");
    // No model in use is at least as strong as the bot's: it checks its own work's evidence.
    assert_eq!(role(&view, "verify")["source"], "own");
    assert_eq!(view["escalate"], false);

    let (status, global) = spade
        .put(
            "/v1/models/roles",
            json!({ "roles": { "title": "fake/m", "review": "fake/cheap" }, "escalate": true }),
        )
        .await?;
    assert_eq!(status, 200, "{global}");
    assert_eq!(global["roles"]["review"], "fake/cheap");
    // The global review model is oversight's own setting.
    let (_, oversight) = spade.get("/v1/oversight").await?;
    assert_eq!(oversight["oversight"]["review_model"], "fake/cheap");

    let (status, view) = spade
        .put(&path, json!({ "roles": { "verify": "fake/cheap" } }))
        .await?;
    assert_eq!(status, 200, "{view}");
    assert_eq!(role(&view, "verify")["source"], "bot");
    assert_eq!(role(&view, "title")["source"], "global");
    assert_eq!(role(&view, "review")["model"], "fake/cheap");
    assert_eq!(view["escalate"], true, "the global setting holds");

    for refused in [
        json!({ "roles": { "main": "fake/cheap" } }),
        json!({ "roles": { "helper": "nope/x" } }),
        json!({ "roles": { "helper": "cli:codex/gpt-6.1-sol" } }),
        json!({ "roles": { "advisor": "fake/m" } }),
        json!({ "allowed": ["nope/x"] }),
    ] {
        let (status, body) = spade.put(&path, refused.clone()).await?;
        assert_eq!(status, 400, "{refused} gave {body}");
    }
    let (status, _) = spade
        .put(
            "/v1/agents/nobody/models",
            json!({ "roles": { "helper": null } }),
        )
        .await?;
    assert_eq!(status, 404);

    // Cleared, a role goes back to the global choice, then the default.
    let (_, view) = spade
        .put(&path, json!({ "roles": { "verify": null } }))
        .await?;
    assert_eq!(role(&view, "verify")["source"], "own");
    Ok(())
}

#[tokio::test]
async fn a_step_spade_starts_on_its_own_tells_the_bot_what_it_spent_and_each_roles_model() -> Result
{
    let scripts = vec![
        Script::reply("").call("c1", "task_status", json!({ "status": "working" })),
        Script::reply("On it."),
        title(),
        Script::reply("").call("c2", "task_status", json!({ "status": "done" })),
        Script::reply("Done."),
    ];
    let spade = Spade::start(scripts, vec![Arc::new(TaskStatus) as Arc<dyn Tool>]).await?;
    cheap_fast_model(&spade).await?;
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Builder", "task": "Keep the build green", "model": "fake/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let conversation = body["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Fix the build").await?;
    let events = spade.wait_for(&conversation, "task_continued").await?;
    let nudge = events
        .iter()
        .find(|e| e["type"] == "task_continued")
        .and_then(|e| e["nudge"].as_str())
        .unwrap_or_default()
        .to_owned();
    assert!(nudge.contains("<budget>Spent today $"), "{nudge}");
    assert!(nudge.contains("Today by role: main $"), "{nudge}");
    assert!(nudge.contains("helper fake/cheap"), "{nudge}");
    assert!(nudge.contains("information, not a limit"), "{nudge}");
    Ok(())
}

#[tokio::test]
async fn the_check_of_done_runs_on_the_verify_role_and_its_model_is_on_the_verdict() -> Result {
    use spade_server::tools::{TaskGoal, TaskPlan};
    let scripts = vec![
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
        title(),
        // The verifier, on the role's model.
        Script::reply("").plain(
            r#"{"criteria":[{"id":"1","met":true,"why":"2 passed"}],"missing":[],"done":true}"#,
        ),
    ];
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(FakeTool::new(
            "run_tests",
            Risk::Read,
            "test result: ok. 2 passed",
        )),
        Arc::new(TaskStatus),
        Arc::new(TaskGoal),
        Arc::new(TaskPlan),
    ];
    let spade = Spade::start(scripts, tools).await?;
    cheap_fast_model(&spade).await?;
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Builder", "task": "Keep the build green", "model": "fake/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let agent = body["agent"]["id"].as_str().unwrap_or_default().to_owned();
    let conversation = body["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{agent}/models"),
            json!({ "roles": { "verify": "fake/cheap" } }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    spade.say(&conversation, "Run the tests").await?;
    let events = spade.wait_for(&conversation, "task_verified").await?;
    let verdict = events
        .iter()
        .find(|e| e["type"] == "task_verified")
        .cloned()
        .unwrap_or_default();
    assert_eq!(verdict["verdict"], "done", "{verdict}");
    assert_eq!(verdict["model"], "fake/cheap");
    assert_eq!(
        model_asked_with(&spade, "You check whether a task is done").as_deref(),
        Some("cheap")
    );
    Ok(())
}

const SUMMARY: &str =
    r#"{"goal":"Plan a trip","decisions":["Go by train"],"facts":[],"open":[],"references":[]}"#;

/// The model of the newest request.
fn last_model(spade: &Spade) -> Option<String> {
    spade
        .fake
        .seen()
        .last()
        .and_then(|seen| seen.body["model"].as_str().map(str::to_owned))
}

#[tokio::test]
async fn compaction_runs_on_the_compact_role_only_when_that_model_holds_the_prompt() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("First answer."),
            title(),
            Script::reply("Second answer."),
            Script::reply("").plain(SUMMARY),
            Script::reply("Third answer."),
            Script::reply("").plain(SUMMARY),
        ],
        Vec::new(),
    )
    .await?;
    for (id, context) in [("tiny", 1_000), ("sum", 400_000)] {
        let (status, body) = spade
            .post(
                "/v1/endpoints/fake/models",
                json!({ "id": id, "context": context, "capabilities": ["tools", "images"] }),
            )
            .await?;
        assert!(status < 300, "{body}");
    }
    let (status, body) = spade
        .put(
            "/v1/models/roles",
            json!({ "roles": { "compact": "fake/tiny" } }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let id = spade.ask("First question").await?;
    spade.wait_for(&id, "renamed").await?;
    spade.say(&id, "Second question").await?;
    spade.wait_for_count(&id, "reply_finished", 2).await?;
    let compact = format!("/v1/conversations/{id}/compact");
    let (status, _) = spade.post(&compact, json!({})).await?;
    assert_eq!(status, 204);
    // The prompt doesn't fit the compact model's context: the conversation's own model sums up.
    assert_eq!(last_model(&spade).as_deref(), Some("m"));

    let (status, _) = spade
        .put(
            "/v1/models/roles",
            json!({ "roles": { "compact": "fake/sum" } }),
        )
        .await?;
    assert_eq!(status, 200);
    spade.say(&id, "Third question").await?;
    spade.wait_for_count(&id, "reply_finished", 3).await?;
    let (status, _) = spade.post(&compact, json!({})).await?;
    assert_eq!(status, 204);
    assert_eq!(last_model(&spade).as_deref(), Some("sum"));
    let events = spade.events(&id).await?;
    assert_eq!(count(&events, "context_compacted"), 2);
    Ok(())
}
