//! Typed calls between the person's bots (ADR 0200 §7) through Spade's API: a Trip planner calls
//! a packaged Flight watcher's `cheapest_fare`. The call is delivered once, even across a
//! restart; the callee works under its own gate, held to the contract's effects; its output is
//! checked; and Stop on either side ends the call.

mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::effect::Effect;
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::{FakeProvider, Script};
use support::contracts::{call_of, calls, install, of_type, own_endpoint, returns};
use support::packaged::{secure, text};
use support::{FakeTool, Options, Result, Spade};

/// The two bots, each on a fake of its own, and titles on a third.
struct World {
    spade: Spade,
    planner: String,
    watcher_id: String,
    watcher: String,
    /// Titles, the planner's and the watcher's.
    fakes: Vec<FakeProvider>,
}

/// `watcher_scripts` is given the id of the planner's call `p1`, known once the planner exists.
async fn world(
    planner_scripts: Vec<Script>,
    watcher_scripts: impl FnOnce(&str) -> Vec<Script>,
    tools: Vec<Arc<dyn Tool>>,
) -> Result<World> {
    let spade = Spade::start_with(Vec::new(), tools, Options::default()).await?;
    secure(&spade).await?;
    let titles = own_endpoint(
        &spade,
        "Titles",
        vec![Script::reply("").plain(r#"{"title":"T"}"#); 8],
    )
    .await?;
    spade
        .put("/v1/settings", json!({ "fast_model": "titles/t" }))
        .await?;
    let planner_fake = own_endpoint(&spade, "Planner Net", planner_scripts).await?;
    let (status, planner) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Trip planner", "model": "planner-net/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{planner}");
    let planner = text(&planner["agent"]["conversation"]);
    let watcher_fake = own_endpoint(
        &spade,
        "Watcher Net",
        watcher_scripts(&call_of(&planner, "p1")),
    )
    .await?;
    let (status, made) = spade.post("/v1/agents", install()).await?;
    assert_eq!(status, 201, "{made}");
    let watcher_id = text(&made["agent"]["id"]);
    let (status, body) = spade
        .patch(
            &format!("/v1/agents/{watcher_id}"),
            json!({ "model": "watcher-net/m" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(World {
        planner,
        watcher: text(&made["agent"]["conversation"]),
        watcher_id,
        spade,
        fakes: vec![titles, planner_fake, watcher_fake],
    })
}

/// The planner asks; its call to the person's own bot runs without asking them.
async fn ask_planner(world: &World, _job: &str) -> Result {
    world
        .spade
        .say(
            &world.planner,
            "What's the cheapest fare KTM to DEL in January?",
        )
        .await
}

fn calls_delivered(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|e| e["type"] == "user_message" && e["from_agent"]["contract"].is_object())
        .collect()
}

/// The planner's job result for its call.
async fn result(world: &World) -> Result<Value> {
    let events = world.spade.wait_for(&world.planner, "job_finished").await?;
    Ok(of_type(&events, "job_finished")
        .first()
        .map(|e| (*e).clone())
        .unwrap_or_default())
}

#[tokio::test]
async fn a_call_returns_typed_output_and_the_callee_reads_it_as_another_bots_request() -> Result {
    let world = world(
        vec![
            calls("p1"),
            Script::reply("Asked."),
            Script::reply("It's $182."),
        ],
        |call| {
            vec![
                returns("w1", call, json!({ "fare": 182, "currency": "USD" })),
                Script::reply("Sent."),
            ]
        },
        Vec::new(),
    )
    .await?;
    let call = call_of(&world.planner, "p1");
    ask_planner(&world, "p1").await?;

    let done = result(&world).await?;
    assert_eq!(done["is_error"], false, "{done}");
    let content = text(&done["content"]);
    assert!(
        content.starts_with(&format!(
            "<contract_result call=\"{call}\" bot=\"Flight watcher\" contract=\"cheapest_fare\" status=\"returned\""
        )),
        "{content}"
    );
    assert!(content.contains("\"fare\": 182"), "{content}");
    let planner = world.spade.events(&world.planner).await?;
    let called = of_type(&planner, "contract_called");
    assert_eq!(called.len(), 1, "{planner:?}");
    assert_eq!(called[0]["name"], "Flight watcher");
    assert_eq!(called[0]["contract"], "cheapest_fare");

    let theirs = world.spade.events(&world.watcher).await?;
    let delivered = calls_delivered(&theirs);
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0]["from_agent"]["name"], "Trip planner");
    assert_eq!(
        delivered[0]["from_agent"]["contract"]["call"],
        call.as_str()
    );
    let told = world.fakes[2].seen()[0].body["messages"].to_string();
    assert!(
        told.contains("<contract_call from=\\\"Trip planner\\\""),
        "{told}"
    );
    assert!(told.contains("not the person's"), "{told}");
    let ended = of_type(&theirs, "contract_ended");
    assert_eq!(ended[0]["status"], "returned");
    Ok(())
}

#[tokio::test]
async fn output_that_doesnt_fit_goes_back_to_the_callee_twice_then_the_call_fails() -> Result {
    let wrong = || json!({ "fare": "cheap", "currency": "USD" });
    let world = world(
        vec![
            calls("p1"),
            Script::reply("Asked."),
            Script::reply("It failed."),
        ],
        |call| {
            vec![
                returns("w1", call, wrong()),
                returns("w2", call, wrong()),
                returns("w3", call, wrong()),
                Script::reply("I couldn't."),
            ]
        },
        Vec::new(),
    )
    .await?;
    ask_planner(&world, "p1").await?;

    let done = result(&world).await?;
    assert_eq!(done["is_error"], true, "{done}");
    let content = text(&done["content"]);
    assert!(content.contains("status=\"failed\""), "{content}");
    assert!(content.contains("output.fare: is a number"), "{content}");
    let theirs = world.spade.events(&world.watcher).await?;
    assert_eq!(of_type(&theirs, "contract_misfit").len(), 3);
    assert_eq!(of_type(&theirs, "contract_ended")[0]["status"], "failed");
    // The first answers told the watcher what to fix and how many tries were left.
    let second = world.fakes[2].seen()[1].body["messages"].to_string();
    assert!(second.contains("output.fare: is a number"), "{second}");
    assert!(second.contains("2 more tries"), "{second}");
    Ok(())
}

#[tokio::test]
async fn the_callee_cant_use_its_own_effects_outside_what_the_contract_allows() -> Result {
    let post = FakeTool::new("report_post", Risk::Write, "posted").declares(Effect::Publish);
    let fetch =
        FakeTool::new("fares_fetch", Risk::Read, "KTM-DEL 182 USD").declares(Effect::Network);
    let posted = post.calls();
    let fetched = fetch.calls();
    let world = world(
        vec![calls("p1"), Script::reply("Asked."), Script::reply("Done.")],
        |call| {
            vec![
                // Its package declares publishing and reaching the fares host, and the person
                // left both on: the caller still can't have it use them for a call that allows
                // neither.
                Script::reply("")
                    .call("w1", "report_post", json!({ "text": "fares" }))
                    .call("w2", "fares_fetch", json!({ "route": "KTM-DEL" })),
                returns("w3", call, json!({ "fare": 182, "currency": "USD" })),
                Script::reply("Sent."),
            ]
        },
        vec![Arc::new(post), Arc::new(fetch)],
    )
    .await?;
    ask_planner(&world, "p1").await?;
    let done = result(&world).await?;
    assert_eq!(done["is_error"], false, "{done}");

    let theirs = world.spade.events(&world.watcher).await?;
    let refused = |id: &str| {
        theirs
            .iter()
            .find(|e| e["type"] == "tool_finished" && e["call_id"] == id)
            .map(|e| text(&e["content"]))
            .unwrap_or_default()
    };
    assert!(
        refused("w1").contains("The cheapest_fare call doesn't declare publishing"),
        "{}",
        refused("w1")
    );
    assert!(
        refused("w2").contains("The cheapest_fare call doesn't declare reaching outside"),
        "{}",
        refused("w2")
    );
    assert!(
        posted.lock().map(|c| c.is_empty()).unwrap_or(false),
        "never ran"
    );
    assert!(
        fetched.lock().map(|c| c.is_empty()).unwrap_or(false),
        "never ran"
    );
    Ok(())
}

#[tokio::test]
async fn stop_on_the_caller_stops_the_callees_turn_for_the_call() -> Result {
    let world = world(
        vec![calls("p1"), Script::reply("Asked.")],
        |_| vec![Script::reply("Looking…").held(Duration::from_secs(60))],
        Vec::new(),
    )
    .await?;
    ask_planner(&world, "p1").await?;
    world
        .spade
        .wait_for(&world.watcher, "reply_started")
        .await?;
    world
        .spade
        .wait_for(&world.planner, "reply_finished")
        .await?;
    let (status, body) = world
        .spade
        .post(
            &format!("/v1/conversations/{}/stop", world.planner),
            json!({}),
        )
        .await?;
    assert!(status < 300, "{body}");
    let theirs = world
        .spade
        .wait_for(&world.watcher, "reply_stopped")
        .await?;
    assert_eq!(of_type(&theirs, "reply_stopped").len(), 1);
    let done = result(&world).await?;
    assert_eq!(done["is_error"], true, "{done}");
    Ok(())
}

#[tokio::test]
async fn stop_on_the_callee_fails_the_call_as_stopped() -> Result {
    let world = world(
        vec![
            calls("p1"),
            Script::reply("Asked."),
            Script::reply("It was stopped."),
        ],
        |_| vec![Script::reply("Looking…").held(Duration::from_secs(60))],
        Vec::new(),
    )
    .await?;
    ask_planner(&world, "p1").await?;
    world
        .spade
        .wait_for(&world.watcher, "reply_started")
        .await?;
    let (status, body) = world
        .spade
        .post(
            &format!("/v1/conversations/{}/stop", world.watcher),
            json!({}),
        )
        .await?;
    assert!(status < 300, "{body}");
    let done = result(&world).await?;
    assert_eq!(done["is_error"], true, "{done}");
    assert!(
        text(&done["content"]).contains("status=\"stopped\""),
        "{done}"
    );
    Ok(())
}

#[tokio::test]
async fn a_call_is_delivered_once_and_answered_once_across_a_restart_of_both_sides() -> Result {
    let world = world(
        vec![
            calls("p1"),
            Script::reply("Asked."),
            Script::reply("It's $182."),
        ],
        |call| {
            vec![
                Script::reply("Looking…").held(Duration::from_secs(60)),
                // Its next step, after the restart, answers the call it carried on with.
                returns("w1", call, json!({ "fare": 182, "currency": "USD" })),
                Script::reply("Sent."),
            ]
        },
        Vec::new(),
    )
    .await?;
    ask_planner(&world, "p1").await?;
    world
        .spade
        .wait_for(&world.watcher, "reply_started")
        .await?;
    world
        .spade
        .wait_for(&world.planner, "reply_finished")
        .await?;
    let World {
        spade,
        planner,
        watcher,
        fakes,
        ..
    } = world;
    // The old process's call job ends with it, storing nothing.
    spade.engine.drop_jobs_as_on_exit();
    let spade = spade
        .restart_after_stop(Duration::from_millis(200), Vec::new(), Vec::new())
        .await?;
    secure(&spade).await?;

    let events = spade.wait_for(&planner, "job_finished").await?;
    let finished = of_type(&events, "job_finished");
    assert_eq!(finished[0]["is_error"], false, "{events:?}");
    assert!(text(&finished[0]["content"]).contains("\"fare\": 182"));
    spade.wait_for_count(&planner, "reply_finished", 2).await?;
    let events = spade.events(&planner).await?;
    assert_eq!(of_type(&events, "job_finished").len(), 1, "answered once");
    assert_eq!(of_type(&events, "contract_called").len(), 1);
    let theirs = spade.events(&watcher).await?;
    assert_eq!(calls_delivered(&theirs).len(), 1, "delivered once");
    assert_eq!(of_type(&theirs, "contract_ended").len(), 1);
    assert!(
        fakes[2].seen().len() >= 2,
        "the watcher carried on after the restart"
    );
    Ok(())
}

#[tokio::test]
async fn a_bot_whose_calls_are_turned_off_takes_none_and_lists_none() -> Result {
    let world = world(
        vec![
            Script::reply("").call("p0", "contracts_find", json!({ "need": "fare" })),
            calls("p1"),
            Script::reply("It takes no calls."),
        ],
        |_| Vec::new(),
        Vec::new(),
    )
    .await?;
    let (status, body) = world
        .spade
        .get(&format!("/v1/agents/{}/contracts", world.watcher_id))
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["incoming"], true);
    assert_eq!(body["contracts"][0]["name"], "cheapest_fare");
    let (status, body) = world
        .spade
        .put(
            &format!("/v1/agents/{}/contracts", world.watcher_id),
            json!({ "incoming": false }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["incoming"], false);
    ask_planner(&world, "p1").await?;
    let done = result(&world).await?;
    assert_eq!(done["is_error"], true);
    assert!(text(&done["content"]).contains("takes no calls"), "{done}");
    let events = world.spade.events(&world.planner).await?;
    let found = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "p0")
        .map(|e| text(&e["content"]))
        .unwrap_or_default();
    assert!(found.contains("None of the person's bots"), "{found}");
    let theirs = world.spade.events(&world.watcher).await?;
    assert!(calls_delivered(&theirs).is_empty());
    Ok(())
}

#[tokio::test]
async fn a_caller_reads_waiting_while_the_callee_waits_on_the_person_for_its_call() -> Result {
    // The watcher asks the person something mid-call, and waits on them.
    let world = world(
        vec![
            calls("p1"),
            Script::reply("Asked."),
            Script::reply("It's $182."),
        ],
        |call| {
            vec![
                Script::reply("").call("w1", "ask_user", json!({ "question": "Window or aisle?" })),
                returns("w2", call, json!({ "fare": 182, "currency": "USD" })),
                Script::reply("Sent."),
            ]
        },
        Vec::new(),
    )
    .await?;
    ask_planner(&world, "p1").await?;
    world
        .spade
        .wait_for(&world.watcher, "question_asked")
        .await?;
    world
        .spade
        .wait_for(&world.planner, "reply_finished")
        .await?;
    let state = |agents: &Value, name: &str| {
        agents["agents"]
            .as_array()
            .and_then(|all| all.iter().find(|a| a["name"] == name))
            .map(|a| text(&a["state"]))
            .unwrap_or_default()
    };
    let (_, agents) = world.spade.get("/v1/agents").await?;
    assert_eq!(state(&agents, "Flight watcher"), "waiting");
    assert_eq!(state(&agents, "Trip planner"), "waiting", "{agents}");

    // Answered later, the watcher's turn carries on and returns.
    let (status, body) = world
        .spade
        .post(
            &format!("/v1/conversations/{}/questions/w1", world.watcher),
            json!({ "defer": true }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    let done = result(&world).await?;
    assert_eq!(done["is_error"], false, "{done}");
    world
        .spade
        .wait_for_count(&world.planner, "reply_finished", 2)
        .await?;
    let (_, agents) = world.spade.get("/v1/agents").await?;
    assert_ne!(state(&agents, "Trip planner"), "waiting");
    Ok(())
}

#[tokio::test]
async fn a_market_packages_contract_schemas_in_a_file_count_only_as_the_market_signed_them()
-> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    support::market::trust(&spade.engine);
    let inline = support::contracts::watcher();
    let path = "contracts/cheapest-fare.json";
    let schemas = serde_json::to_string_pretty(&json!({
        "input": inline["contracts"][0]["input"],
        "output": inline["contracts"][0]["output"],
    }))?;
    let mut recipe = inline.clone();
    recipe["contracts"][0] = json!({
        "name": "cheapest_fare",
        "summary": "The cheapest fare seen for a route this week.",
        "file": path,
        "effects": [],
    });
    let sealed =
        support::market::envelope_with("flight-watcher", "1.0.0", &recipe, &[(path, &schemas)]);
    let body = |envelope: Value| {
        json!({
            "envelope": envelope,
            "from_recipe": { "source": "market", "name": "flight-watcher", "version": "1.0.0", "transaction": "install-1" },
            "grants": { "connectors": [], "plugins": [], "skills": [] },
            "switches": {},
        })
    };
    // A schema file other than the one signed, or none, makes nothing.
    let mut changed = sealed.clone();
    changed["files"][path] = json!(schemas.replace("\"minimum\": 0", "\"minimum\": 1"));
    let (status, refused) = spade.post("/v1/agents", body(changed)).await?;
    assert_eq!(status, 400, "{refused}");
    assert!(
        refused.to_string().contains("isn't one the market signed"),
        "{refused}"
    );
    let mut missing = sealed.clone();
    missing["files"] = json!({});
    let (status, refused) = spade.post("/v1/agents", body(missing)).await?;
    assert_eq!(status, 400, "{refused}");
    assert!(
        refused.to_string().contains("isn't in the package"),
        "{refused}"
    );
    let (_, listed) = spade.get("/v1/agents").await?;
    assert!(!listed.to_string().contains("Flight watcher"), "{listed}");

    // As signed, the bot publishes the file's schemas as if bot.json held them.
    let (status, made) = spade.post("/v1/agents", body(sealed)).await?;
    assert_eq!(status, 201, "{made}");
    let bot = text(&made["agent"]["id"]);
    let (status, view) = spade.get(&format!("/v1/agents/{bot}/contracts")).await?;
    assert_eq!(status, 200, "{view}");
    let published = &view["contracts"][0];
    assert_eq!(published["name"], "cheapest_fare", "{view}");
    assert_eq!(
        published["input"], inline["contracts"][0]["input"],
        "{view}"
    );
    assert_eq!(
        published["output"], inline["contracts"][0]["output"],
        "{view}"
    );
    Ok(())
}
