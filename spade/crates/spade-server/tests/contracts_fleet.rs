//! Contract calls between the person's machines (ADR 0200 §7 over ADR 0132's asks): a Trip
//! planner on the laptop calls the Flight watcher on the studio through the fake fleet of
//! daemons. The call is listed, delivered once though the studio restarts mid-call, and its
//! typed answer comes back.

mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_testkit::{FakeProvider, Script};
use support::contracts::{call_of, input, install, of_type, own_endpoint, returns};
use support::fleet::{Fleet, machine};
use support::packaged::text;
use support::{Result, Spade};

async fn quiet_titles(spade: &Spade) -> Result<FakeProvider> {
    let fake = own_endpoint(
        spade,
        "Titles",
        vec![Script::reply("").plain(r#"{"title":"T"}"#); 8],
    )
    .await?;
    spade
        .put("/v1/settings", json!({ "fast_model": "titles/t" }))
        .await?;
    Ok(fake)
}

fn result_of(events: &[Value], call: &str) -> String {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        .map(|e| text(&e["content"]))
        .unwrap_or_default()
}

#[tokio::test]
async fn a_call_to_another_machine_is_listed_delivered_once_across_its_restart_and_answered()
-> Result {
    let fleet = Arc::new(Fleet::default());
    let laptop = machine(&fleet, "host-laptop", "Laptop", Vec::new()).await?;
    let studio = machine(&fleet, "host-studio", "Studio", Vec::new()).await?;
    let _laptop_titles = quiet_titles(&laptop).await?;
    let _studio_titles = quiet_titles(&studio).await?;

    let _planner_fake = own_endpoint(
        &laptop,
        "Planner Net",
        vec![
            Script::reply("").call("p0", "contracts_find", json!({ "need": "cheapest fare" })),
            Script::reply("").call(
                "p1",
                "contract_call",
                json!({ "bot": "Flight watcher", "machine": "Studio", "contract": "cheapest_fare", "input": input() }),
            ),
            Script::reply("Asked the studio."),
            Script::reply("It's $182."),
        ],
    )
    .await?;
    let (status, planner) = laptop
        .post(
            "/v1/agents",
            json!({ "name": "Trip planner", "model": "planner-net/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{planner}");
    let planner = text(&planner["agent"]["conversation"]);
    let call = call_of(&planner, "p1");

    let watcher_fake = own_endpoint(
        &studio,
        "Watcher Net",
        vec![
            Script::reply("Looking…").held(Duration::from_secs(60)),
            returns("w1", &call, json!({ "fare": 182, "currency": "USD" })),
            Script::reply("Sent."),
        ],
    )
    .await?;
    let (status, made) = studio.post("/v1/agents", install()).await?;
    assert_eq!(status, 201, "{made}");
    let watcher_id = text(&made["agent"]["id"]);
    let watcher = text(&made["agent"]["conversation"]);
    let (status, body) = studio
        .patch(
            &format!("/v1/agents/{watcher_id}"),
            json!({ "model": "watcher-net/m" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");

    laptop
        .say(&planner, "What's the cheapest fare KTM to DEL in January?")
        .await?;
    studio.wait_for(&watcher, "reply_started").await?;
    let ours = laptop.events(&planner).await?;
    let found = result_of(&ours, "p0");
    assert!(
        found.contains("cheapest_fare") && found.contains("\"machine\":\"Studio\""),
        "{found}"
    );

    // The studio restarts while its watcher works on the call; the call carries on there.
    studio
        .engine
        .pause_for_stop(Duration::from_millis(200))
        .await;
    let studio = support::fleet::restart(&fleet, "host-studio", studio).await?;

    let events = laptop.wait_for(&planner, "job_finished").await?;
    let finished = of_type(&events, "job_finished");
    assert_eq!(finished[0]["is_error"], false, "{events:?}");
    let content = text(&finished[0]["content"]);
    assert!(
        content.contains("bot=\"Flight watcher on Studio\"") && content.contains("\"fare\": 182"),
        "{content}"
    );
    // Another machine's bot's output is untrusted unless its machine says it read nothing so.
    let called = of_type(&events, "contract_called");
    assert_eq!(called[0]["machine_name"], "Studio");

    let theirs = studio.events(&watcher).await?;
    let delivered: Vec<&Value> = theirs
        .iter()
        .filter(|e| e["type"] == "user_message" && e["from_agent"]["contract"].is_object())
        .collect();
    assert_eq!(delivered.len(), 1, "delivered once: {delivered:?}");
    assert_eq!(delivered[0]["from_agent"]["machine"], "Laptop");
    assert_eq!(delivered[0]["from_agent"]["name"], "Trip planner");
    assert_eq!(of_type(&theirs, "contract_ended").len(), 1);
    assert!(
        watcher_fake.seen().len() >= 2,
        "it carried on after the restart"
    );
    Ok(())
}

#[tokio::test]
async fn a_call_from_another_machine_to_a_bot_that_takes_none_is_refused() -> Result {
    let fleet = Arc::new(Fleet::default());
    let laptop = machine(&fleet, "host-laptop", "Laptop", Vec::new()).await?;
    let studio = machine(&fleet, "host-studio", "Studio", Vec::new()).await?;
    let _titles = quiet_titles(&laptop).await?;
    let (status, made) = studio.post("/v1/agents", install()).await?;
    assert_eq!(status, 201, "{made}");
    let watcher_id = text(&made["agent"]["id"]);
    let (status, _) = studio
        .put(
            &format!("/v1/agents/{watcher_id}/contracts"),
            json!({ "incoming": false }),
        )
        .await?;
    assert_eq!(status, 200);
    let _planner_fake = own_endpoint(
        &laptop,
        "Planner Net",
        vec![
            Script::reply("").call(
                "p1",
                "contract_call",
                json!({ "bot": watcher_id, "machine": "Studio", "contract": "cheapest_fare", "input": input() }),
            ),
            Script::reply("Asked."),
            Script::reply("It won't take calls."),
        ],
    )
    .await?;
    let (_, planner) = laptop
        .post(
            "/v1/agents",
            json!({ "name": "Trip planner", "model": "planner-net/m" }),
        )
        .await?;
    let planner = text(&planner["agent"]["conversation"]);
    laptop.say(&planner, "Ask the studio's watcher").await?;
    let events = laptop.wait_for(&planner, "job_finished").await?;
    let finished = of_type(&events, "job_finished");
    assert_eq!(finished[0]["is_error"], true);
    let content = text(&finished[0]["content"]);
    assert!(content.contains("offers"), "{content}");
    Ok(())
}

/// Trip planner's state on its machine, read until it is `want` (or the wait runs out).
async fn reads(spade: &Spade, name: &str, want: &str) -> Result<String> {
    let mut state = String::new();
    for _ in 0..400 {
        let (_, body) = spade.get("/v1/agents").await?;
        state = body["agents"]
            .as_array()
            .and_then(|all| all.iter().find(|a| a["name"] == name))
            .map(|a| text(&a["state"]))
            .unwrap_or_default();
        if state == want {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(state)
}

#[tokio::test]
async fn a_caller_reads_waiting_while_a_callee_on_another_machine_waits_on_the_person() -> Result {
    let fleet = Arc::new(Fleet::default());
    let laptop = machine(&fleet, "host-laptop", "Laptop", Vec::new()).await?;
    let studio = machine(&fleet, "host-studio", "Studio", Vec::new()).await?;
    let _laptop_titles = quiet_titles(&laptop).await?;
    let _studio_titles = quiet_titles(&studio).await?;
    let _planner_fake = own_endpoint(
        &laptop,
        "Planner Net",
        vec![
            Script::reply("").call(
                "p1",
                "contract_call",
                json!({ "bot": "Flight watcher", "machine": "Studio", "contract": "cheapest_fare", "input": input() }),
            ),
            Script::reply("Asked the studio."),
            Script::reply("It's $182."),
        ],
    )
    .await?;
    let (_, planner) = laptop
        .post(
            "/v1/agents",
            json!({ "name": "Trip planner", "model": "planner-net/m" }),
        )
        .await?;
    let planner = text(&planner["agent"]["conversation"]);
    let call = call_of(&planner, "p1");
    let _watcher_fake = own_endpoint(
        &studio,
        "Watcher Net",
        vec![
            // The watcher asks the person mid-call, then answers slowly once they have.
            Script::reply("").call("w1", "ask_user", json!({ "question": "Window or aisle?" })),
            returns("w2", &call, json!({ "fare": 182, "currency": "USD" }))
                .held(Duration::from_secs(2)),
            Script::reply("Sent."),
        ],
    )
    .await?;
    let (status, made) = studio.post("/v1/agents", install()).await?;
    assert_eq!(status, 201, "{made}");
    let watcher_id = text(&made["agent"]["id"]);
    let watcher = text(&made["agent"]["conversation"]);
    studio
        .patch(
            &format!("/v1/agents/{watcher_id}"),
            json!({ "model": "watcher-net/m" }),
        )
        .await?;

    laptop.say(&planner, "Cheapest fare KTM to DEL?").await?;
    studio.wait_for(&watcher, "question_asked").await?;
    assert_eq!(reads(&laptop, "Trip planner", "waiting").await?, "waiting");

    let (status, body) = studio
        .post(
            &format!("/v1/conversations/{watcher}/questions/w1"),
            json!({ "defer": true }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    // Answered there: the call is open again, never done and no longer waiting here.
    assert_eq!(reads(&laptop, "Trip planner", "working").await?, "working");

    let events = laptop.wait_for(&planner, "job_finished").await?;
    let finished = of_type(&events, "job_finished");
    assert_eq!(finished[0]["is_error"], false, "{events:?}");
    assert!(text(&finished[0]["content"]).contains("\"fare\": 182"));
    Ok(())
}
