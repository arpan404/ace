//! When a bot compacts and what it keeps (ADR 0216): at 90% of the smallest window on its route,
//! or the person's lower cap; old tool results age out in batches only when the person turns it
//! on; the person's words survive word for word. Through the real engine and API, on a scripted
//! model.

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
async fn a_bot_on_a_million_token_model_compacts_near_ninety_percent_keeping_the_persons_words()
-> Result {
    // The first step reports a 905,011-token prompt: past 90% of the window.
    let spade = Spade::start(
        vec![
            Script::reply("On it.").cached(905_000, 0),
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
    // The reported 905,011 plus an estimate of what came after it.
    let before = compacted
        .and_then(|e| e["tokens_before"].as_u64())
        .unwrap_or(0);
    assert!(
        (905_011..906_000).contains(&before),
        "{before}: {:?}",
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
async fn a_bot_on_a_million_token_model_does_not_compact_at_three_quarters() -> Result {
    // 800,011 tokens: past 75% of the window, under 90%.
    let spade = Spade::start(
        vec![
            Script::reply("On it.").cached(800_000, 0),
            title(),
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
    assert!(
        !types(&events).iter().any(|t| t == "context_compacted"),
        "{:?}",
        types(&events)
    );
    Ok(())
}

#[tokio::test]
async fn a_bots_own_cap_compacts_it_sooner_whatever_the_global_one() -> Result {
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
    let (agent, id) = big_bot(&spade).await?;
    // A global cap that would not compact at 170k; the bot's own, lower, wins.
    let (status, global) = spade
        .put("/v1/models/roles", json!({ "context_tokens": 500_000 }))
        .await?;
    assert_eq!(status, 200, "{global}");
    assert_eq!(global["context_tokens"], json!(500_000));
    let path = format!("/v1/agents/{agent}/models");
    let (status, _) = spade.put(&path, json!({ "context_tokens": 1_000 })).await?;
    assert_eq!(status, 400, "a cap too small to work in is refused");
    let (status, view) = spade
        .put(&path, json!({ "context_tokens": 100_000 }))
        .await?;
    assert_eq!(status, 200, "{view}");
    assert_eq!(
        view["context_tokens"],
        json!({ "tokens": 100_000, "source": "bot" })
    );

    spade.say(&id, STANDING).await?;
    spade.wait_for(&id, "renamed").await?;
    spade.say(&id, "Now fix the build.").await?;
    let events = spade.wait_for_count(&id, "reply_finished", 2).await?;
    assert!(
        types(&events).iter().any(|t| t == "context_compacted"),
        "170k is past this bot's 100k cap: {:?}",
        types(&events)
    );
    Ok(())
}

/// Turns aging on for every bot, as the person would on the model roles settings.
async fn aging_on(spade: &Spade) -> Result {
    let (status, global) = spade
        .put("/v1/models/roles", json!({ "age_results": true }))
        .await?;
    assert_eq!(status, 200, "{global}");
    assert_eq!(global["age_results"], json!(true));
    Ok(())
}

#[tokio::test]
async fn old_results_stay_whole_unless_the_person_turns_aging_on() -> Result {
    let page = format!("page {}", "x".repeat(15_000));
    let read = support::FakeTool::new("read_page", spade_core::tools::Risk::Read, &page);
    let mut scripts = Vec::new();
    for n in 0..24 {
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
    assert!(
        !types(&events).iter().any(|t| t == "results_aged"),
        "{:?}",
        types(&events)
    );
    let last = spade
        .fake
        .seen()
        .into_iter()
        .map(|s| s.body)
        .rfind(|b| {
            b["messages"]
                .as_array()
                .is_some_and(|m| m.iter().any(|m| m["role"] == "tool"))
        })
        .unwrap_or(Value::Null);
    let results = tool_texts(&last);
    assert_eq!(results.len(), 24);
    assert!(
        results.iter().all(|r| r.len() > 15_000),
        "every result is whole"
    );
    Ok(())
}

#[tokio::test]
async fn a_long_task_ages_old_results_in_batches_and_the_stub_says_how_to_get_one_back() -> Result {
    const STEPS: usize = 24;
    let first = format!("ZEBRA-0 {}", "x".repeat(15_000));
    let page = format!("page {}", "x".repeat(15_000));
    let read = support::FakeTool::new("read_page", spade_core::tools::Risk::Read, &page)
        .then_answers(&[&first, &page]);
    let mut scripts = Vec::new();
    for n in 0..STEPS {
        scripts.push(Script::reply("").call(&format!("c{n}"), "read_page", json!({ "n": n })));
    }
    // The bot follows the stub's pointer back to the first page.
    scripts.push(Script::reply("").call("back", "history_read", json!({ "from": 1, "count": 8 })));
    scripts.push(Script::reply("Read them all."));
    let spade = Spade::start(
        scripts,
        vec![Arc::new(read) as Arc<dyn spade_server::tools::Tool>],
    )
    .await?;
    aging_on(&spade).await?;
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
        !results[0].contains("ZEBRA-0"),
        "the aged page is out of the prompt"
    );
    // The stub's pointer is within what the bot read back, and that read has the page whole.
    let pointer = results[0]
        .split("\"from\": ")
        .nth(1)
        .and_then(|rest| rest.split(',').next())
        .and_then(|n| n.parse::<u64>().ok());
    assert!(
        pointer.is_some_and(|p| (1..=8).contains(&p)),
        "{}",
        results[0]
    );
    let read_back = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["name"] == "history_read")
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default();
    assert!(
        read_back.contains(&format!("read_page result: ZEBRA-0 {}", "x".repeat(9_000))),
        "{read_back:.300}"
    );
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

#[tokio::test]
async fn a_helper_following_a_stub_reads_its_own_history_back() -> Result {
    let first = format!("ZEBRA-0 {}", "x".repeat(15_000));
    let page = format!("page {}", "x".repeat(15_000));
    let lookup = support::FakeTool::new("lookup", spade_core::tools::Risk::Read, &page)
        .then_answers(&[&first, &page]);
    let linger = support::FakeTool::new("linger", spade_core::tools::Risk::Read, "ok")
        .slow(std::time::Duration::from_secs(3));
    let mut scripts = vec![Script::reply("Hello."), title()];
    // The bot's step outlasts the helper's, so the scripts arrive in order.
    scripts.push(
        Script::reply("")
            .call("h1", "helper", json!({ "task": "Read the pages" }))
            .call("w1", "linger", json!({})),
    );
    scripts.extend(
        (0..16).map(|n| Script::reply("").call(&format!("l{n}"), "lookup", json!({ "n": n }))),
    );
    scripts.push(Script::reply("").call("back", "history_read", json!({ "from": 1, "count": 6 })));
    scripts.extend([
        Script::reply("Read them."),
        Script::reply("A helper is reading."),
        Script::reply("The helper read them."),
    ]);
    let spade = Spade::start(
        scripts,
        vec![
            Arc::new(lookup) as Arc<dyn spade_server::tools::Tool>,
            Arc::new(linger) as Arc<dyn spade_server::tools::Tool>,
        ],
    )
    .await?;
    aging_on(&spade).await?;
    let agent = spade.new_agent("Reader", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;
    spade.say(&conversation, "Read the pages").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;

    let helper_bodies: Vec<String> = spade
        .fake
        .seen()
        .iter()
        .map(|seen| seen.body.to_string())
        .filter(|body| body.contains("You are a helper Spade started"))
        .collect();
    assert!(
        helper_bodies.iter().any(|b| b.contains("[Aged out")),
        "the helper's old results aged"
    );
    let last = helper_bodies.last().cloned().unwrap_or_default();
    assert!(
        !last.contains("This conversation has no bot"),
        "{last:.300}"
    );
    assert!(
        last.contains("lookup result: ZEBRA-0 xxxx"),
        "the page came back whole"
    );
    Ok(())
}

#[tokio::test]
async fn a_step_compacts_before_it_would_overflow_the_smallest_window_on_its_route() -> Result {
    // The bot's model has a 1M window, but its fallback only 32k: 22k reported, then three
    // 20,000-character results, is about 37k for the next request, past 90% of 32k.
    let big = support::FakeTool::new("dump", spade_core::tools::Risk::Read, &"y".repeat(30_000));
    let spade = Spade::start(
        vec![
            Script::reply("")
                .call("d1", "dump", json!({ "n": 1 }))
                .call("d2", "dump", json!({ "n": 2 }))
                .call("d3", "dump", json!({ "n": 3 }))
                .cached(22_000, 0),
            Script::reply("").plain(SUMMARY),
            Script::reply("Done."),
        ],
        vec![Arc::new(big) as Arc<dyn spade_server::tools::Tool>],
    )
    .await?;
    let (agent, id) = big_bot(&spade).await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints/fake/models",
            json!({ "id": "small", "context": 32_000, "capabilities": ["tools", "images"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (status, view) = spade
        .put(
            &format!("/v1/agents/{agent}/models"),
            json!({ "roles": { "main": ["fake/small"] } }),
        )
        .await?;
    assert_eq!(status, 200, "{view}");
    spade.say(&id, STANDING).await?;
    let events = spade.wait_for(&id, "reply_finished").await?;
    let compacted = events.iter().find(|e| e["type"] == "context_compacted");
    let before = compacted
        .and_then(|e| e["tokens_before"].as_u64())
        .unwrap_or(0);
    assert!(before > 28_800, "{before}: {:?}", types(&events));
    Ok(())
}
