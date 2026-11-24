//! What each conversation is offered, frozen (spade/docs/harness.md, Tools): a bot's learned pins
//! arrive with its next compaction, never mid-conversation, and a lane or helper keeps the list it
//! started with, so the prompt's top stays byte-stable for the provider's cache (docs/design.md,
//! Caching).

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::{Route, Script};
use support::lanes::{self, route, starts, title, warm_up};
use support::{FakeTool, Options, Result, Spade};

/// Tools every bot is offered whatever else changes (spade/docs/harness.md, Tools); these are the
/// ones this test's toolbox carries.
const CORE: [&str; 8] = [
    "ask_user",
    "call_tool",
    "helper",
    "memory_save",
    "profile_update",
    "task_start",
    "tool_search",
    "wait_for",
];

/// A bot on `fake/big`, a model with a 1,000,000-token window: its conversation's id.
async fn big_bot(spade: &Spade) -> Result<String> {
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
    Ok(body["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

/// The model steps of one conversation, in the order the fake answered them. Only streamed ones:
/// a summary or a title is a plain call and never a turn's step.
fn steps_in(spade: &Spade, conversation: &str) -> Vec<Value> {
    spade
        .fake
        .seen()
        .into_iter()
        .filter(|seen| seen.body["stream"] == true)
        .filter(|seen| {
            seen.headers
                .iter()
                .any(|(name, value)| name == "x-session" && value == conversation)
        })
        .map(|seen| seen.body)
        .collect()
}

/// Waits until `conversation` has made `count` steps (a held one may finish after the caller's own
/// turns do), then answers them.
async fn wait_steps(spade: &Spade, conversation: &str, count: usize) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let steps = steps_in(spade, conversation);
        if steps.len() >= count || Instant::now() > deadline {
            return steps;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// The tools one request offered, as the provider received them.
fn offered(body: &Value) -> Value {
    let tools = body["tools"].clone();
    assert!(
        tools.as_array().is_some_and(|tools| tools.len() > 5),
        "a real request carries a real tool list: {tools}"
    );
    tools
}

fn names(body: &Value) -> Vec<String> {
    offered(body)
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .map(|tool| {
                    tool["function"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned()
                })
                .collect()
        })
        .unwrap_or_default()
}

fn assert_core(body: &Value) {
    let names = names(body);
    for name in CORE {
        assert!(names.contains(&name.to_owned()), "{name} in {names:?}");
    }
}

/// The first step of `steps` whose prompt carries `text`.
fn first_with(steps: &[Value], text: &str) -> Value {
    steps
        .iter()
        .find(|body| body.to_string().contains(text))
        .cloned()
        .unwrap_or_else(|| panic!("no step carried {text}"))
}

/// The last step of `steps` whose prompt carries `text`.
fn last_with(steps: &[Value], text: &str) -> Value {
    steps
        .iter()
        .rfind(|body| body.to_string().contains(text))
        .cloned()
        .unwrap_or_else(|| panic!("no step carried {text}"))
}

/// Where the last streamed request of `conversation` sits in what the fake answered.
fn last_step_at(spade: &Spade, conversation: &str) -> usize {
    spade
        .fake
        .seen()
        .iter()
        .rposition(|seen| {
            seen.body["stream"] == true
                && seen
                    .headers
                    .iter()
                    .any(|(name, value)| name == "x-session" && value == conversation)
        })
        .unwrap_or_else(|| panic!("no step in {conversation}"))
}

/// Where the first streamed step of `conversation` whose prompt carries `text` sits in what the
/// fake answered.
fn step_at_with(spade: &Spade, conversation: &str, text: &str) -> usize {
    spade
        .fake
        .seen()
        .iter()
        .position(|seen| {
            seen.body["stream"] == true
                && seen
                    .headers
                    .iter()
                    .any(|(name, value)| name == "x-session" && value == conversation)
                && seen.body.to_string().contains(text)
        })
        .unwrap_or_else(|| panic!("no step of {conversation} carried {text}"))
}

/// A step that reaches twice for `often` and once for `rare`, both deferred.
fn using_often_and_rare(usage: Option<u32>) -> Script {
    let call = |id: &str, name: &str| {
        (
            id.to_owned(),
            "call_tool".to_owned(),
            json!({ "name": name, "arguments": {} }),
        )
    };
    let script = Script::reply("Looking.");
    let script = match usage {
        Some(tokens) => script.cached(tokens, 0),
        None => script,
    };
    let (a, b, c) = (call("c1", "often"), call("c2", "often"), call("c3", "rare"));
    script
        .call(&a.0, &a.1, a.2)
        .call(&b.0, &b.1, b.2)
        .call(&c.0, &c.1, c.2)
}

fn tools() -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(FakeTool::new("often", Risk::Read, "often done").deferred("Used often")),
        Arc::new(FakeTool::new("rare", Risk::Read, "rare done").deferred("Used rarely")),
    ]
}

#[tokio::test]
async fn a_tool_a_bot_uses_twice_is_offered_up_front_after_its_next_compaction() -> Result {
    // The first step reports 905,011 tokens: past 90% of the window, so the next one compacts.
    let spade = Spade::start_turns(
        vec![
            using_often_and_rare(Some(905_000)),
            Script::reply("Done."),
            Script::reply("Still here."),
        ],
        title(),
        tools(),
    )
    .await?;
    let id = big_bot(&spade).await?;
    spade.say(&id, "Find the issue.").await?;
    spade.wait_for_count(&id, "reply_finished", 1).await?;
    spade.say(&id, "And again.").await?;
    spade.wait_for_count(&id, "reply_finished", 2).await?;

    let steps = steps_in(&spade, &id);
    let first = first_with(&steps, "Find the issue.");
    assert_core(&first);
    assert!(
        !names(&first).contains(&"often".to_owned()),
        "deferred until it is used: {:?}",
        names(&first)
    );
    let later = last_with(&steps, "And again.");
    assert_core(&later);
    let names = names(&later);
    assert!(
        names.contains(&"often".to_owned()),
        "used twice, so it is offered up front after the compaction: {names:?}"
    );
    assert!(
        !names.contains(&"rare".to_owned()),
        "used once, so it stays deferred: {names:?}"
    );
    Ok(())
}

#[tokio::test]
async fn a_conversations_tools_stay_byte_identical_across_calls_and_a_restart() -> Result {
    let spade = Spade::start_turns(
        vec![
            using_often_and_rare(None),
            Script::reply("Done."),
            Script::reply("Still here."),
        ],
        title(),
        tools(),
    )
    .await?;
    let id = big_bot(&spade).await?;
    spade.say(&id, "Find the issue.").await?;
    spade.wait_for_count(&id, "reply_finished", 1).await?;
    spade.say(&id, "And again.").await?;
    spade.wait_for_count(&id, "reply_finished", 2).await?;

    let steps = steps_in(&spade, &id);
    let first = first_with(&steps, "Find the issue.");
    let later = last_with(&steps, "And again.");
    assert_core(&first);
    assert_eq!(
        offered(&first),
        offered(&later),
        "the prompt's top must stay byte-stable for the provider's cache"
    );
    assert!(
        !names(&later).contains(&"often".to_owned()),
        "a pin waits for the next conversation or compaction"
    );

    // The same database, a new process: the stored list is what goes out again.
    let spade = spade
        .restart(tools(), vec![Script::reply("After the restart.")])
        .await?;
    spade.say(&id, "Once more.").await?;
    spade.wait_for_count(&id, "reply_finished", 3).await?;
    let after = last_with(&steps_in(&spade, &id), "Once more.");
    assert_core(&after);
    assert_eq!(
        offered(&first),
        offered(&after),
        "a restart re-reads the same stored list"
    );
    Ok(())
}

#[tokio::test]
async fn a_lane_keeps_the_list_it_started_with_when_its_bot_compacts() -> Result {
    let routes = vec![route(
        "Fix the March invoice",
        vec![
            // Held, so the bot compacts while the lane's turn is still open.
            Script::reply("Looking.")
                .held(Duration::from_secs(4))
                .call("l1", "lookup", json!({})),
            Script::reply("Found it."),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        using_often_and_rare(None),
        Script::reply("Done."),
        starts("t1", "Fix the March invoice"),
        Script::reply("Started."),
        // Past 90% of the window: the next step runs after a compaction.
        Script::reply("Working.")
            .cached(905_000, 0)
            .call("c9", "lookup", json!({})),
        Script::reply("Done."),
    ]);
    let mut tools = tools();
    tools.push(Arc::new(FakeTool::new("lookup", Risk::Read, "found")));
    let spade = Spade::start_routed(routes, main, tools, Options::default()).await?;
    let id = big_bot(&spade).await?;
    spade.say(&id, "Hi").await?;
    spade.wait_for(&id, "renamed").await?;
    spade.say(&id, "Find the issue.").await?;
    spade.wait_for_count(&id, "reply_finished", 2).await?;
    spade.say(&id, "Fix the March invoice.").await?;
    spade.wait_for_count(&id, "reply_finished", 3).await?;
    spade.say(&id, "Carry on.").await?;
    let events = spade.wait_for_count(&id, "reply_finished", 4).await?;
    assert!(
        events.iter().any(|e| e["type"] == "context_compacted"),
        "the bot compacted: {:?}",
        support::types(&events)
    );

    let lane_conversation = lanes::tasks(&spade, &id)
        .await?
        .first()
        .and_then(|task| task["conversation"].as_str())
        .map(str::to_owned)
        .ok_or("the lane is not listed")?;
    let lane_steps = wait_steps(&spade, &lane_conversation, 2).await;
    assert_eq!(lane_steps.len(), 2, "the lane took two steps");

    let bot_steps = steps_in(&spade, &id);
    let started_with = first_with(&bot_steps, "Fix the March invoice.");
    let bot_after = bot_steps.last().cloned().unwrap_or(Value::Null);
    assert_core(&started_with);
    assert_core(&lane_steps[0]);
    assert_eq!(
        offered(&started_with),
        offered(&lane_steps[0]),
        "a lane is offered its bot's list as it stood when it started"
    );
    assert_eq!(
        offered(&lane_steps[0]),
        offered(&lane_steps[1]),
        "a bot's compaction never changes a running lane's list"
    );
    assert!(
        names(&bot_after).contains(&"often".to_owned()),
        "the bot itself has the pin now: {:?}",
        names(&bot_after)
    );
    assert!(
        !names(&lane_steps[1]).contains(&"often".to_owned()),
        "the lane keeps the list it started with: {:?}",
        names(&lane_steps[1])
    );
    assert!(
        last_step_at(&spade, &lane_conversation) > step_at_with(&spade, &id, "<summary>"),
        "the lane's second step ran after the bot's compaction"
    );
    Ok(())
}

#[tokio::test]
async fn a_helpers_compaction_leaves_its_bots_offered_tools_alone() -> Result {
    // Only a helper's prompt carries Spade's rules for helpers, so its route never catches the
    // bot's own calls.
    let routes = vec![Route::when(
        spade_core::helper::RULES,
        vec![
            // Past 90% of the window: the helper compacts before its next step.
            Script::reply("Working.")
                .cached(905_000, 0)
                .call("h1", "lookup", json!({})),
            Script::reply("").plain(
                r#"{"goal":"Read the notes","decisions":[],"commitments":[],"facts":[],"open":[],"references":[],"notes":[]}"#,
            ),
            Script::reply("They say the build passes."),
        ],
    )];
    let main = vec![
        Script::reply("Hi."),
        title(),
        Script::reply("On it.").call("h0", "helper", json!({ "task": "Read the release notes" })),
        Script::reply("Started."),
        Script::reply("It read them."),
    ];
    let spade = Spade::start_routed(
        routes,
        main,
        vec![Arc::new(FakeTool::new("lookup", Risk::Read, "found"))],
        Options::default(),
    )
    .await?;
    let id = big_bot(&spade).await?;
    spade.say(&id, "Hi").await?;
    spade.wait_for(&id, "renamed").await?;
    spade.say(&id, "Have it read the notes.").await?;
    spade.wait_for_count(&id, "reply_finished", 2).await?;

    let (_, helpers) = spade
        .get(&format!("/v1/conversations/{id}/helpers"))
        .await?;
    let helper_conversation = helpers["helpers"]
        .as_array()
        .and_then(|list| list.first())
        .and_then(|helper| helper["conversation"].as_str())
        .map(str::to_owned)
        .ok_or("the helper is not listed")?;
    let helper_steps = wait_steps(&spade, &helper_conversation, 2).await;
    assert_eq!(helper_steps.len(), 2, "the helper took two steps");

    let bot_steps = steps_in(&spade, &id);
    let bot_before = first_with(&bot_steps, "Have it read the notes.");
    let bot_after = last_with(&bot_steps, "Have it read the notes.");
    assert_core(&helper_steps[0]);
    assert_eq!(
        offered(&bot_before),
        offered(&helper_steps[0]),
        "a helper is offered its bot's list byte for byte"
    );
    assert!(
        helper_steps[1].to_string().contains("<summary>"),
        "the helper compacted between its steps"
    );
    assert_eq!(
        offered(&helper_steps[0]),
        offered(&helper_steps[1]),
        "a helper's own compaction republishes the same list"
    );
    assert_eq!(
        offered(&bot_before),
        offered(&bot_after),
        "a helper's compaction never changes its bot's list"
    );
    Ok(())
}
