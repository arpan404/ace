//! A bot's context stays small (ADR 0216): it compacts at its working budget, not at three
//! quarters of a million-token window; old tool results age out in batches; the person's words
//! survive both word for word. Through the real engine and API, on a scripted model.

mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use spade_testkit::Script;
use support::{Result, Spade, types};

const SUMMARY: &str = r#"{"goal":"Fix the build","decisions":["Use the new linker"],"commitments":["Report back when it passes"],"facts":[],"open":[],"references":[]}"#;
const STANDING: &str = "Always run the tests before you commit, and never push to main.";

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Build"}"#)
}

/// A bot on `fake/big`, a model with a 1,000,000-token window: its id and conversation.
async fn big_bot(spade: &Spade) -> Result<(String, String)> {
    let (status, body) = spade
        .post(
            "/v1/endpoints/fake/models",
            json!({ "id": "big", "context": 1_000_000, "capabilities": ["tools", "images"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Builder", "task": "", "model": "fake/big" }),
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

fn person_texts(body: &Value) -> Vec<String> {
    body["messages"]
        .as_array()
        .map(|m| {
            m.iter()
                .filter(|m| m["role"] == "user")
                .map(|m| m["content"].as_str().unwrap_or("").to_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn tool_texts(body: &Value) -> Vec<String> {
    body["messages"]
        .as_array()
        .map(|m| {
            m.iter()
                .filter(|m| m["role"] == "tool")
                .map(|m| m["content"].as_str().unwrap_or("").to_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn a_bot_on_a_million_token_model_compacts_at_its_working_budget_keeping_the_persons_words()
-> Result {
    // The first step reports a 170,011-token prompt: under 75% of the window, over the budget.
    let spade = Spade::start(
        vec![
            Script::reply("On it.").cached(170_000, 0),
            title(),
            Script::reply("").plain(SUMMARY),
            Script::reply("Tests pass."),
        ],
        Vec::new(),
    )
    .await?;
    let (_, id) = big_bot(&spade).await?;
    spade.say(&id, STANDING).await?;
    spade.wait_for(&id, "renamed").await?;
    spade.say(&id, "Now fix the build.").await?;
    let events = spade.wait_for_count(&id, "reply_finished", 2).await?;

    let compacted = events.iter().find(|e| e["type"] == "context_compacted");
    assert_eq!(
        compacted.map(|e| e["tokens_before"].clone()),
        Some(json!(170_011)),
        "{:?}",
        types(&events)
    );
    let last = spade
        .fake
        .seen()
        .last()
        .map(|s| s.body.clone())
        .unwrap_or(Value::Null);
    let people = person_texts(&last);
    let summary = &people[0];
    assert!(summary.starts_with("<summary>"), "{people:?}");
    assert!(
        summary.contains(STANDING),
        "the person's words survive whole: {summary}"
    );
    assert!(summary.contains("Report back when it passes"), "{summary}");
    Ok(())
}

#[tokio::test]
async fn a_bots_own_working_budget_is_honoured() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("On it.").cached(170_000, 0),
            title(),
            Script::reply("Tests pass."),
        ],
        Vec::new(),
    )
    .await?;
    let (agent, id) = big_bot(&spade).await?;
    // A global budget that would compact at 170k; the bot's own, larger, wins.
    let (status, global) = spade
        .put("/v1/models/roles", json!({ "context_tokens": 50_000 }))
        .await?;
    assert_eq!(status, 200, "{global}");
    assert_eq!(global["context_tokens"], json!(50_000));
    let path = format!("/v1/agents/{agent}/models");
    let (status, _) = spade.put(&path, json!({ "context_tokens": 1_000 })).await?;
    assert_eq!(status, 400, "a budget too small to work in is refused");
    let (status, view) = spade
        .put(&path, json!({ "context_tokens": 300_000 }))
        .await?;
    assert_eq!(status, 200, "{view}");
    assert_eq!(
        view["context_tokens"],
        json!({ "tokens": 300_000, "source": "bot" })
    );

    spade.say(&id, STANDING).await?;
    spade.wait_for(&id, "renamed").await?;
    spade.say(&id, "Now fix the build.").await?;
    let events = spade.wait_for_count(&id, "reply_finished", 2).await?;
    assert!(
        !types(&events).iter().any(|t| t == "context_compacted"),
        "170k is under this bot's 300k budget, whatever the global one: {:?}",
        types(&events)
    );

    let (_, global) = spade.get("/v1/models/roles").await?;
    assert_eq!(global["context_tokens_default"], json!(128_000));
    Ok(())
}

#[tokio::test]
async fn a_long_task_ages_old_results_in_batches_and_the_stub_says_how_to_get_one_back() -> Result {
    const STEPS: usize = 24;
    let page = format!("page {}", "x".repeat(15_000));
    let read = support::FakeTool::new("read_page", spade_core::tools::Risk::Read, &page);
    let mut scripts = Vec::new();
    for n in 0..STEPS {
        scripts.push(Script::reply("").call(&format!("c{n}"), "read_page", json!({ "n": n })));
    }
    scripts.push(Script::reply("Read them all."));
    let spade = Spade::start(
        scripts,
        vec![Arc::new(read) as Arc<dyn spade_server::tools::Tool>],
    )
    .await?;
    let id = spade.ask(STANDING).await?;
    let events = spade.wait_for(&id, "reply_finished").await?;

    let batches: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "results_aged")
        .collect();
    assert!(
        (2..STEPS / 3).contains(&batches.len()),
        "{} batches: {:?}",
        batches.len(),
        types(&events)
    );
    let steps: Vec<Value> = spade
        .fake
        .seen()
        .into_iter()
        .map(|s| s.body)
        .filter(|b| {
            b["messages"]
                .as_array()
                .is_some_and(|m| m.iter().any(|m| m["role"] == "tool"))
        })
        .collect();
    let last = steps.last().cloned().unwrap_or(Value::Null);
    let results = tool_texts(&last);
    assert!(results[0].starts_with("[Aged out"), "{:.200}", results[0]);
    assert!(
        results[0].contains("read_page") && results[0].contains("history_read"),
        "{}",
        results[0]
    );
    assert!(
        results.last().is_some_and(|r| r.len() > 15_000),
        "the latest result is whole"
    );
    assert!(
        person_texts(&last).iter().any(|t| t.contains(STANDING)),
        "the person's message never ages"
    );
    // Between batches each request only grows at its end: its messages start with the
    // previous request's, so the provider's cache holds. A batch breaks that once.
    let mut broken = 0;
    for pair in steps.windows(2) {
        let (before, after) = (&pair[0]["messages"], &pair[1]["messages"]);
        let before = before.as_array().cloned().unwrap_or_default();
        let after = after.as_array().cloned().unwrap_or_default();
        if after.len() < before.len() || after[..before.len()] != before[..] {
            broken += 1;
        }
    }
    assert_eq!(broken, batches.len(), "only a batch changes earlier bytes");
    Ok(())
}
