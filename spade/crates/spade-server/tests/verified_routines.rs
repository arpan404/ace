//! Routines whose trigger says `"verify": true` and the package's `criterion` checks (ADR 0204
//! §3), through the real engine and API on a scripted fake endpoint. A verified run opens a goal
//! from its instruction with the package's criteria, and reads done only once the separate check
//! of done says so; a check that says "not yet" gets two more tries, and then the run fails,
//! never done. Every model, the verifier included, is the fake.

mod support;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_testkit::Script;
use support::{Result, Spade};

const CRITERION: &str = "It names the cheapest fare it found.";

fn watcher() -> Value {
    json!({
        "format": "spade-bot",
        "version": 3,
        "requires": { "runtime": "1" },
        "name": "Flight watcher",
        "blurb": "Watches fares.",
        "task": "You watch flight fares for the person.",
        "triggers": [
            { "kind": "message" },
            { "kind": "schedule", "name": "Morning fares", "instruction": "Check today's fares.",
              "schedule": "daily at 7:00", "verify": true }
        ],
        "checks": [{ "name": "names-the-fare", "on": ["goal"], "kind": "criterion", "text": CRITERION }],
        "pricing": { "kind": "free" }
    })
}

/// The bot's steps: plan one item, close it with a link, and say it is done.
fn claims_done() -> Vec<Script> {
    vec![
        Script::reply("")
            .call(
                "c1",
                "task_plan",
                json!({ "op": "add", "text": "look up fares" }),
            )
            .call(
                "c2",
                "task_plan",
                json!({ "op": "done", "item": "1",
                        "evidence": [{ "kind": "url", "url": "https://fares.example/ktm-del" }] }),
            )
            .call("c3", "task_status", json!({ "status": "done" })),
        Script::reply("The cheapest is 182 USD."),
    ]
}

fn verdict(met: bool) -> Script {
    Script::reply("").plain(&format!(
        r#"{{"criteria":[{{"id":"1","met":{met},"why":"seen"}}],"missing":["Name the fare in the evidence."],"done":{met}}}"#
    ))
}

/// Installs the package and fires its verified routine now; the bot and its conversation.
async fn fired(spade: &Spade) -> Result<(String, String)> {
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({
                "recipe": watcher(),
                "from_recipe": { "source": "local", "name": "flight-watcher", "version": "dev" },
                "grants": { "connectors": [], "plugins": [], "skills": [] },
                "switches": {},
                "start_routines": false,
            }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let bot = made["agent"]["id"].as_str().unwrap_or_default().to_owned();
    let chat = made["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, body) = spade
        .patch(&format!("/v1/agents/{bot}"), json!({ "model": "fake/m" }))
        .await?;
    assert_eq!(status, 200, "{body}");
    let routine = routine(spade, &bot).await?["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, body) = spade
        .post(&format!("/v1/routines/{routine}/run"), json!({}))
        .await?;
    assert_eq!(status, 202, "{body}");
    Ok((bot, chat))
}

async fn routine(spade: &Spade, bot: &str) -> Result<Value> {
    let (_, listed) = spade.get(&format!("/v1/agents/{bot}/routines")).await?;
    listed["routines"]
        .as_array()
        .and_then(|all| all.iter().find(|r| r["name"] == "Morning fares").cloned())
        .ok_or_else(|| "no routine for the verified trigger".into())
}

/// Waits until the routine's last run reads `result`; every result it read on the way.
async fn run_reads(spade: &Spade, bot: &str, result: &str) -> Result<Vec<String>> {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut seen: Vec<String> = Vec::new();
    loop {
        let run = routine(spade, bot).await?["last_run"].clone();
        let now = run["result"].as_str().unwrap_or_default().to_owned();
        if seen.last() != Some(&now) {
            seen.push(now.clone());
        }
        if now == result {
            return Ok(seen);
        }
        if Instant::now() > deadline {
            return Err(format!("the run never read {result}: {seen:?} {run}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == kind).collect()
}

#[tokio::test]
async fn a_verified_run_opens_a_goal_with_the_packages_criteria_and_reads_done_once_checked()
-> Result {
    let spade = Spade::start_turns(claims_done(), verdict(true), Vec::new()).await?;
    let (bot, chat) = fired(&spade).await?;
    let seen = run_reads(&spade, &bot, "verified").await?;
    assert!(!seen.contains(&"answered".to_owned()), "{seen:?}");
    let events = spade.events(&chat).await?;
    let goal = of_type(&events, "goal_set");
    assert_eq!(goal.len(), 1, "{goal:?}");
    assert_eq!(goal[0]["text"], "Check today's fares.");
    assert_eq!(goal[0]["criteria"][0]["text"], CRITERION);
    assert!(goal[0]["run"].is_string(), "{}", goal[0]);
    // The run's message told the bot what done means.
    let asked = of_type(&events, "user_message");
    assert!(
        asked[0]["text"]
            .as_str()
            .is_some_and(|t| t.contains(CRITERION)),
        "{}",
        asked[0]
    );
    assert_eq!(of_type(&events, "task_verified")[0]["verdict"], "done");
    Ok(())
}

#[tokio::test]
async fn a_verified_run_the_check_refuses_three_times_fails_and_never_reads_done() -> Result {
    let mut turns = claims_done();
    // Sent back twice, each time it adds an item, closes it and says done again.
    for item in 2..=3 {
        turns.push(
            Script::reply("")
                .call(&format!("a{item}"), "task_plan", json!({ "op": "add", "text": "name the fare" }))
                .call(
                    &format!("d{item}"),
                    "task_plan",
                    json!({ "op": "done", "item": item.to_string(),
                            "evidence": [{ "kind": "url", "url": "https://fares.example/ktm-del" }] }),
                )
                .call(&format!("s{item}"), "task_status", json!({ "status": "done" })),
        );
        turns.push(Script::reply("Done again."));
    }
    let spade = Spade::start_turns(turns, verdict(false), Vec::new()).await?;
    let (bot, chat) = fired(&spade).await?;
    let seen = run_reads(&spade, &bot, "failed").await?;
    assert!(!seen.contains(&"verified".to_owned()), "{seen:?}");
    let run = routine(&spade, &bot).await?["last_run"].clone();
    assert!(
        run["detail"]
            .as_str()
            .is_some_and(|d| d.contains("not yet 3 times") && d.contains("Name the fare")),
        "{run}"
    );
    let events = spade.events(&chat).await?;
    let verdicts: Vec<&Value> = of_type(&events, "task_verified");
    assert_eq!(verdicts.len(), 3, "{verdicts:?}");
    assert!(verdicts.iter().all(|v| v["verdict"] == "not_yet"));
    let ended = of_type(&events, "goal_cleared");
    assert_eq!(ended.len(), 1, "{ended:?}");
    assert_eq!(ended[0]["failed"], true);
    let (_, task) = spade.get(&format!("/v1/agents/{bot}/task")).await?;
    assert_ne!(task["task"]["progress"]["state"], "done", "{task}");
    Ok(())
}
