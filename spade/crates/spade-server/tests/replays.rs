//! Replaying kept runs through the API (ADR 0204 §2), on the real engine and a scripted fake
//! endpoint standing in for the person's model. A free replay runs the version the bot has (or
//! the one an update would bring) and says how many kept runs replay the same; a model replay
//! runs only on a model the person names, says about what it costs first, and a run they marked
//! is compared with the kept one by one call on their review model.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::{Result, Spade};

fn watcher(task: &str) -> Value {
    json!({
        "format": "spade-bot",
        "version": 3,
        "requires": { "runtime": "1" },
        "name": "Flight watcher",
        "blurb": "Watches fares.",
        "task": task,
        "pricing": { "kind": "free" }
    })
}

/// A packaged bot that answered one question, kept as a test marked right.
async fn kept(spade: &Spade) -> Result<(String, String)> {
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({
                "recipe": watcher("You watch flight fares for the person."),
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
    spade.say(&chat, "What does KTM to DEL cost?").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let reply = events
        .iter()
        .find(|e| e["type"] == "reply_finished")
        .and_then(|e| e["reply"].as_str())
        .unwrap_or_default()
        .to_owned();
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/cases"),
            json!({ "reply": reply, "mark": "right", "why": "It named the fare." }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok((
        bot,
        body["case"]["id"].as_str().unwrap_or_default().to_owned(),
    ))
}

async fn replayed(spade: &Spade, bot: &str, body: Value) -> Result<Value> {
    let (status, body) = tokio::time::timeout(
        Duration::from_secs(60),
        spade.post(&format!("/v1/agents/{bot}/cases/replay"), body),
    )
    .await??;
    assert_eq!(status, 200, "{body}");
    Ok(body["replay"].clone())
}

#[tokio::test]
async fn a_free_replay_runs_the_bots_own_version_or_the_one_an_update_brings() -> Result {
    let spade = Spade::start_turns(
        vec![Script::reply("KTM to DEL is 182 USD.")],
        Script::reply("").plain(r#"{"title":"Fares"}"#),
        Vec::new(),
    )
    .await?;
    let (bot, case) = kept(&spade).await?;
    let asked = spade.fake.seen().len();
    let own = replayed(&spade, &bot, json!({})).await?;
    assert_eq!(own["mode"], "wiring");
    assert_eq!(own["summary"], "The 1 kept run replays the same.", "{own}");
    assert_eq!(own["cases"][0]["id"], case.as_str());
    let update = replayed(
        &spade,
        &bot,
        json!({ "recipe": watcher("You watch flight and hotel prices."), "cases": [case] }),
    )
    .await?;
    assert_eq!(update["passed"], 1, "{update}");
    // A free replay never reaches the person's model.
    assert_eq!(spade.fake.seen().len(), asked);
    Ok(())
}

#[tokio::test]
async fn a_bot_from_no_package_needs_the_version_to_replay() -> Result {
    let spade = Spade::start(vec![Script::reply("Hi.")], Vec::new()).await?;
    let agent = spade.new_agent("Helper", "Help").await?;
    let bot = agent["id"].as_str().unwrap_or_default();
    let (status, body) = spade
        .post(&format!("/v1/agents/{bot}/cases/replay"), json!({}))
        .await?;
    assert_eq!(status, 409, "{body}");
    Ok(())
}

#[tokio::test]
async fn a_model_replay_says_its_cost_first_and_a_worse_outcome_than_a_right_run_fails() -> Result {
    // Plain requests (the title, the comparison) all get the review model's answer.
    let spade = Spade::start_turns(
        vec![
            Script::reply("KTM to DEL is 182 USD."),
            Script::reply("KTM to DEL is 240 USD."),
        ],
        Script::reply("")
            .plain(r#"{"holds":false,"why":"It names a dearer fare than the kept run."}"#),
        Vec::new(),
    )
    .await?;
    let (bot, _) = kept(&spade).await?;
    let (status, body) = spade
        .get(&format!("/v1/agents/{bot}/cases/replay?model=current"))
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["estimate"]["cases"], 1);
    assert_eq!(body["estimate"]["model"], "fake/m");
    let (status, _) = spade
        .get(&format!("/v1/agents/{bot}/cases/replay?model=nobody/none"))
        .await?;
    assert_eq!(status, 400);
    let report = replayed(&spade, &bot, json!({ "model": "current" })).await?;
    assert_eq!(report["mode"], "model");
    let case = &report["cases"][0];
    assert_eq!(case["passed"], false, "{report}");
    assert_eq!(
        case["lines"][0],
        "Worse than the kept run: It names a dearer fare than the kept run."
    );
    assert_eq!(
        report["summary"],
        "0 of 1 kept run the same or better. 1 worse: see why."
    );
    // The comparison quoted both outcomes as data.
    let compared = spade
        .fake
        .seen()
        .iter()
        .map(|s| s.body.to_string())
        .find(|b| b.contains("You compare two outcomes"))
        .unwrap_or_default();
    assert!(
        compared.contains("182 USD") && compared.contains("240 USD"),
        "{compared}"
    );
    Ok(())
}
