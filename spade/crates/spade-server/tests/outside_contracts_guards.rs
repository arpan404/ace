//! Contracts out (ADR 0202 §3, §6, amendment 2): what keeps one of the person's outside agents
//! inside its own grant, through the stand-in for ace's daemon. A Stop reaches only the call it
//! names; a call's record outlives the inbox's cleanup; reading a task costs the call's own
//! events and waits are capped; a captured stamp can't be replayed or moved; MCP request ids
//! keep their JSON type.

mod support;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::Event;
use spade_server::engine::{OUTSIDE_WAITS_PER_GRANT, OutsideCallState, OutsideCaller};
use spade_store::Store;
use spade_testkit::Script;
use support::contracts::{input, of_type, returns};
use support::outside::{
    DAEMON_TOKEN, Daemon, TOOL, a2a, call_of, deliveries, fare, message, now_ms, stamp, world,
};
use support::{Result, TOKEN};

fn held() -> Vec<Script> {
    vec![Script::reply("Looking…").held(Duration::from_secs(60))]
}

fn caller(grant: &str) -> OutsideCaller {
    OutsideCaller {
        grant: grant.to_owned(),
        name: String::new(),
    }
}

fn at_once(key: &str) -> Value {
    let mut sent = message(key, TOOL, input());
    sent["configuration"] = json!({ "returnImmediately": true });
    sent
}

/// A second connection to the Spade's own database, as its cleanup and its history see it.
fn store_of(world: &support::contracts::World) -> Result<Store> {
    Ok(Store::open(&world.spade.dir.path().join("spade.sqlite"))?)
}

/// Waits until the watcher holds `count` calls.
async fn delivered(world: &support::contracts::World, count: usize) -> Result {
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        let events = world.spade.events(&world.watcher).await?;
        if deliveries(&events).len() >= count {
            return Ok(());
        }
        assert!(Instant::now() < until, "{events:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn cancelling_one_grants_call_leaves_another_grants_call_on_the_same_bot_running() -> Result {
    let (world, daemon) = world(held(), Vec::new()).await?;
    // Grant one's call opens the watcher's turn; grant two's joins it.
    let one = a2a(
        &daemon,
        "bearer-one",
        Some("1.0"),
        "SendMessage",
        at_once("m-1"),
    )
    .await?;
    assert_eq!(
        one["result"]["task"]["status"]["state"], "TASK_STATE_WORKING",
        "{one}"
    );
    world
        .spade
        .wait_for(&world.watcher, "reply_started")
        .await?;
    let two = a2a(
        &daemon,
        "bearer-two",
        Some("1.0"),
        "SendMessage",
        at_once("m-2"),
    )
    .await?;
    assert_eq!(
        two["result"]["task"]["status"]["state"], "TASK_STATE_WORKING",
        "{two}"
    );
    delivered(&world, 2).await?;

    let cancelled = a2a(
        &daemon,
        "bearer-two",
        Some("1.0"),
        "CancelTask",
        json!({ "id": call_of("g_two", "m-2") }),
    )
    .await?;
    assert_eq!(
        cancelled["result"]["status"]["state"], "TASK_STATE_CANCELED",
        "{cancelled}"
    );
    // The turn serves grant one too: it carries on, and grant one's call is still open.
    let theirs = world.spade.events(&world.watcher).await?;
    assert!(of_type(&theirs, "reply_stopped").is_empty(), "{theirs:?}");
    let state = world
        .spade
        .engine
        .outside_state(&caller("g_one"), &call_of("g_one", "m-1"));
    assert_eq!(state, OutsideCallState::Open { waiting: false });
    let read = a2a(
        &daemon,
        "bearer-one",
        Some("1.0"),
        "GetTask",
        json!({ "id": call_of("g_one", "m-1") }),
    )
    .await?;
    assert_eq!(
        read["result"]["status"]["state"], "TASK_STATE_WORKING",
        "{read}"
    );
    Ok(())
}

#[tokio::test]
async fn an_outside_calls_record_outlives_the_inbox_cleanup_and_a_retried_key_never_delivers_again()
-> Result {
    let done = call_of("g_one", "m-done");
    let mut scripts = vec![returns("w1", &done, fare()), Script::reply("Sent.")];
    scripts.extend(held());
    let (world, daemon) = world(scripts, Vec::new()).await?;
    let sent = a2a(
        &daemon,
        "bearer-one",
        Some("1.0"),
        "SendMessage",
        message("m-done", TOOL, input()),
    )
    .await?;
    assert_eq!(
        sent["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
        "{sent}"
    );
    let open = a2a(
        &daemon,
        "bearer-one",
        Some("1.0"),
        "SendMessage",
        at_once("m-open"),
    )
    .await?;
    assert_eq!(
        open["result"]["task"]["status"]["state"], "TASK_STATE_WORKING",
        "{open}"
    );
    delivered(&world, 2).await?;

    // The inbox's cleanup of every ask older than now, and the outside calls' own of every call
    // that ended: the open call's record stays through both.
    let store = store_of(&world)?;
    store.prune_inbox(i64::MAX)?;
    let get = |key: &str| {
        a2a(
            &daemon,
            "bearer-one",
            Some("1.0"),
            "GetTask",
            json!({ "id": call_of("g_one", key) }),
        )
    };
    let read = get("m-open").await?;
    assert_eq!(
        read["result"]["status"]["state"], "TASK_STATE_WORKING",
        "{read}"
    );
    let read = get("m-done").await?;
    assert_eq!(
        read["result"]["status"]["state"], "TASK_STATE_COMPLETED",
        "{read}"
    );
    assert_eq!(read["result"]["artifacts"][0]["parts"][0]["data"], fare());

    // The key again, now naming another skill: the original task and outcome, nothing new.
    let retried = a2a(
        &daemon,
        "bearer-one",
        Some("1.0"),
        "SendMessage",
        message("m-done", "trip_planner__plan", input()),
    )
    .await?;
    let task = &retried["result"]["task"];
    assert_eq!(task["id"], done.as_str(), "{retried}");
    assert_eq!(task["status"]["state"], "TASK_STATE_COMPLETED");
    assert_eq!(task["artifacts"][0]["parts"][0]["data"], fare());
    assert_eq!(
        deliveries(&world.spade.events(&world.watcher).await?).len(),
        2
    );

    store.prune_outside(i64::MAX)?;
    let read = get("m-open").await?;
    assert_eq!(
        read["result"]["status"]["state"], "TASK_STATE_WORKING",
        "{read}"
    );
    Ok(())
}

#[tokio::test]
async fn polling_a_task_reads_the_calls_own_events_however_long_the_callees_history() -> Result {
    let (world, daemon) = world(held(), Vec::new()).await?;
    // A long history before the call: events of a kind this build doesn't know, so the turn
    // gives the model none of them but a reader from the start pays for every one.
    let padding: Vec<Event> = (0..5_000)
        .map(|i| Event::Unknown(json!({ "type": "x_padding", "i": i, "text": "x".repeat(2_000) })))
        .collect();
    store_of(&world)?.append_all(&world.watcher, &padding, now_ms())?;
    let sent = a2a(
        &daemon,
        "bearer-one",
        Some("1.0"),
        "SendMessage",
        at_once("m-poll"),
    )
    .await?;
    assert_eq!(
        sent["result"]["task"]["status"]["state"], "TASK_STATE_WORKING",
        "{sent}"
    );

    // The same request for a task this grant never made reads nothing: what the path itself
    // costs here, through both hops.
    let polls = |task: String, state: &'static str| {
        let daemon = &daemon;
        async move {
            let started = Instant::now();
            for _ in 0..50 {
                let read = a2a(
                    daemon,
                    "bearer-one",
                    Some("1.0"),
                    "GetTask",
                    json!({ "id": task }),
                )
                .await?;
                let read_state = read["result"]["status"]["state"]
                    .as_str()
                    .or_else(|| read["error"]["message"].as_str());
                assert_eq!(read_state, Some(state), "{read}");
            }
            Result::Ok(started.elapsed())
        }
    };
    let path = polls(call_of("g_one", "never"), "Task not found").await?;
    let task = polls(call_of("g_one", "m-poll"), "TASK_STATE_WORKING").await?;
    // Reading 10 MB of history twice a poll takes many times the path's own cost.
    assert!(
        task < path * 2 + Duration::from_secs(1),
        "50 polls took {task:?}, the path alone {path:?}"
    );
    Ok(())
}

/// `SendMessage` for `key`, waiting, as a task of its own.
fn waiting(daemon: &Daemon, bearer: &'static str, key: &str) -> tokio::task::JoinHandle<Value> {
    let daemon = Daemon {
        url: daemon.url.clone(),
    };
    let sent = message(key, TOOL, input());
    tokio::spawn(async move {
        a2a(&daemon, bearer, Some("1.0"), "SendMessage", sent)
            .await
            .unwrap_or_default()
    })
}

#[tokio::test]
async fn a_grant_waits_on_so_many_calls_at_once_and_one_beyond_is_refused_undelivered() -> Result {
    let (world, daemon) = world(held(), Vec::new()).await?;
    let waits: Vec<_> = (0..OUTSIDE_WAITS_PER_GRANT)
        .map(|i| waiting(&daemon, "bearer-one", &format!("m-wait-{i}")))
        .collect();
    delivered(&world, OUTSIDE_WAITS_PER_GRANT).await?;

    let beyond = a2a(
        &daemon,
        "bearer-one",
        Some("1.0"),
        "SendMessage",
        message("m-beyond", TOOL, input()),
    )
    .await?;
    assert_eq!(beyond["error"]["code"], -32004, "{beyond}");
    let events = world.spade.events(&world.watcher).await?;
    assert_eq!(deliveries(&events).len(), OUTSIDE_WAITS_PER_GRANT);
    // A task sent to be read later needs no wait; another grant has slots of its own.
    let later = a2a(
        &daemon,
        "bearer-one",
        Some("1.0"),
        "SendMessage",
        at_once("m-later"),
    )
    .await?;
    assert_eq!(
        later["result"]["task"]["status"]["state"], "TASK_STATE_WORKING",
        "{later}"
    );
    let other = waiting(&daemon, "bearer-two", "m-other");
    delivered(&world, OUTSIDE_WAITS_PER_GRANT + 2).await?;
    for wait in waits {
        wait.abort();
    }
    other.abort();
    Ok(())
}

/// Posts `body` to Spade's `route` with `stamped`, as only ace's daemon can sign it.
async fn post(
    world: &support::contracts::World,
    route: &str,
    body: &[u8],
    stamped: &[(&'static str, String)],
) -> Result<u16> {
    let mut request = reqwest::Client::new()
        .post(format!("{}{route}", world.spade.base))
        .bearer_auth(TOKEN)
        .header("content-type", "application/json")
        .body(body.to_vec());
    for (header, value) in stamped {
        request = request.header(*header, value);
    }
    Ok(request.send().await?.status().as_u16())
}

#[tokio::test]
async fn a_captured_stamp_is_refused_when_replayed_or_moved_to_another_route() -> Result {
    let (world, _daemon) = world(Vec::new(), Vec::new()).await?;
    let body = serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))?;
    let sign = |route: &str| {
        stamp(
            "ace:outside:g_one",
            "Claude%20Code",
            "POST",
            route,
            &[],
            &body,
            DAEMON_TOKEN,
        )
    };
    let listed = sign("/v1/outside/mcp");
    assert_eq!(post(&world, "/v1/outside/mcp", &body, &listed).await?, 200);
    // The same forward again, within the stamp's time.
    assert_eq!(post(&world, "/v1/outside/mcp", &body, &listed).await?, 403);

    // A stamp for the A2A route, unused, sent to MCP instead: refused, and still good where it
    // was signed for.
    let for_a2a = sign("/v1/outside/a2a");
    assert_eq!(post(&world, "/v1/outside/mcp", &body, &for_a2a).await?, 403);
    assert_ne!(post(&world, "/v1/outside/a2a", &body, &for_a2a).await?, 403);
    Ok(())
}

/// A legacy MCP `tools/call` with JSON-RPC id `id`, posted through the daemon.
fn legacy_call(daemon: &Daemon, id: Value, key: &str) -> tokio::task::JoinHandle<Value> {
    let url = format!("{}/mcp", daemon.url);
    let body = json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/call",
        "params": {
            "name": TOOL,
            "arguments": input(),
            "_meta": { spade_mcp::serve::KEY_META: key },
        },
    });
    tokio::spawn(async move {
        let sent = reqwest::Client::new()
            .post(url)
            .bearer_auth("bearer-one")
            .json(&body)
            .send()
            .await;
        match sent {
            Ok(answer) => answer.json().await.unwrap_or_default(),
            Err(_) => Value::Null,
        }
    })
}

#[tokio::test]
async fn a_legacy_cancel_for_request_7_stops_that_call_not_the_one_with_id_quote_7() -> Result {
    let (world, daemon) = world(held(), Vec::new()).await?;
    let number = legacy_call(&daemon, json!(7), "k-number");
    delivered(&world, 1).await?;
    let text = legacy_call(&daemon, json!("7"), "k-text");
    delivered(&world, 2).await?;

    // An id still in flight is refused before anything is delivered.
    let again = legacy_call(&daemon, json!(7), "k-again").await?;
    assert_eq!(again["error"]["code"], -32600, "{again}");
    assert_eq!(
        deliveries(&world.spade.events(&world.watcher).await?).len(),
        2
    );

    let cancel = reqwest::Client::new()
        .post(format!("{}/mcp", daemon.url))
        .bearer_auth("bearer-one")
        .json(&json!({
            "jsonrpc": "2.0", "method": "notifications/cancelled",
            "params": { "requestId": "7" },
        }))
        .send()
        .await?;
    assert_eq!(cancel.status().as_u16(), 202);
    let stopped = text.await?;
    assert_eq!(stopped["result"]["isError"], true, "{stopped}");
    let engine = &world.spade.engine;
    assert!(matches!(
        engine.outside_state(&caller("g_one"), &call_of("g_one", "k-text")),
        OutsideCallState::Ended(spade_core::contract::Outcome::Stopped { .. })
    ));
    assert_eq!(
        engine.outside_state(&caller("g_one"), &call_of("g_one", "k-number")),
        OutsideCallState::Open { waiting: false }
    );
    number.abort();
    Ok(())
}
