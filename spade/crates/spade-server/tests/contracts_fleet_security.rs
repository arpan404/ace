//! Contract calls between the person's machines (ADR 0200 §7 over ADR 0132's asks), where they
//! can go wrong: Stop reaches a call its machine took though the answer was lost on the way; a
//! call names its calling bot as a bot of the sending machine, never one of the receiver's; and
//! a caller holding an older version of the contract reads output a newer version added to.

mod support;

use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde_json::{Value, json};
use spade_testkit::{FakeProvider, Script};
use support::contracts::{
    call_of, from_schema_file, input, install, of_type, own_endpoint, returns, watcher,
};
use support::fleet::{Fleet, deliver, machine};
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

/// The laptop's Trip planner and the studio's Flight watcher (installed from `install`), each on
/// a fake of its own. `watcher` is given the id of the planner's call `p1`.
struct Pair {
    fleet: Arc<Fleet>,
    laptop: Spade,
    studio: Spade,
    planner: String,
    watcher_id: String,
    watcher: String,
    fakes: Vec<FakeProvider>,
}

async fn pair(
    planner: Vec<Script>,
    watcher: impl FnOnce(&str) -> Vec<Script>,
    installed: Value,
) -> Result<Pair> {
    let fleet = Arc::new(Fleet::default());
    let laptop = machine(&fleet, "host-laptop", "Laptop", Vec::new()).await?;
    let studio = machine(&fleet, "host-studio", "Studio", Vec::new()).await?;
    if installed.get("envelope").is_some() {
        support::market::trust(&studio.engine);
    }
    let mut fakes = vec![quiet_titles(&laptop).await?, quiet_titles(&studio).await?];
    fakes.push(own_endpoint(&laptop, "Planner Net", planner).await?);
    let (status, made) = laptop
        .post(
            "/v1/agents",
            json!({ "name": "Trip planner", "model": "planner-net/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let planner = text(&made["agent"]["conversation"]);
    fakes.push(own_endpoint(&studio, "Watcher Net", watcher(&call_of(&planner, "p1"))).await?);
    let (status, made) = studio.post("/v1/agents", installed).await?;
    assert_eq!(status, 201, "{made}");
    let watcher_id = text(&made["agent"]["id"]);
    let (status, body) = studio
        .patch(
            &format!("/v1/agents/{watcher_id}"),
            json!({ "model": "watcher-net/m" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(Pair {
        fleet,
        laptop,
        studio,
        planner,
        watcher: text(&made["agent"]["conversation"]),
        watcher_id,
        fakes,
    })
}

fn calls_studio() -> Script {
    Script::reply("").call(
        "p1",
        "contract_call",
        json!({ "bot": "Flight watcher", "machine": "Studio", "contract": "cheapest_fare", "input": input() }),
    )
}

#[tokio::test]
async fn stop_reaches_a_call_its_machine_took_though_the_answer_was_lost() -> Result {
    let pair = pair(
        vec![
            calls_studio(),
            Script::reply("Asked the studio."),
            Script::reply("It was stopped."),
        ],
        |_| vec![Script::reply("Looking…").held(std::time::Duration::from_secs(60))],
        install(),
    )
    .await?;
    // The studio takes the call, but every answer to it is lost on the way back.
    pair.fleet.lose_call_answers.store(true, Ordering::SeqCst);
    pair.laptop.say(&pair.planner, "Cheapest fare?").await?;
    pair.studio.wait_for(&pair.watcher, "reply_started").await?;
    pair.laptop
        .wait_for(&pair.planner, "reply_finished")
        .await?;

    let (status, body) = pair
        .laptop
        .post(
            &format!("/v1/conversations/{}/stop", pair.planner),
            json!({}),
        )
        .await?;
    assert!(status < 300, "{body}");
    // Not withdrawn here alone: the stop reaches the studio, and its watcher's turn ends.
    let theirs = pair.studio.wait_for(&pair.watcher, "reply_stopped").await?;
    assert_eq!(of_type(&theirs, "reply_stopped").len(), 1);
    let carried = pair
        .fleet
        .carried
        .lock()
        .map(|c| c.clone())
        .unwrap_or_default();
    let call = call_of(&pair.planner, "p1");
    assert!(
        carried
            .iter()
            .any(|r| r.contains("\"op\":\"stop\"") && r.contains(&call)),
        "{carried:?}"
    );
    Ok(())
}

#[tokio::test]
async fn a_call_from_another_machine_is_from_a_bot_of_that_machine_never_one_of_this() -> Result {
    let pair = pair(
        Vec::new(),
        |_| {
            vec![
                Script::reply("")
                    .call(
                        "w1",
                        "contract_return",
                        json!({ "call": "cc.c_laptop.p9", "output": { "fare": 182, "currency": "USD" } }),
                    ),
                Script::reply("Sent."),
            ]
        },
        install(),
    )
    .await?;
    let base = pair
        .fleet
        .spades
        .lock()
        .map(|s| {
            s.iter()
                .find(|(host, _, _)| host == "host-studio")
                .map(|(_, base, _)| base.clone())
        })
        .ok()
        .flatten()
        .unwrap_or_default();
    let call = |key: &str, from: Value| {
        json!({
            "op": "contract_call", "key": key, "to": pair.watcher_id, "contract": "cheapest_fare",
            "input": input(), "from": from, "depth": 1,
        })
    };

    // Posing as the studio's own watcher, or naming no bot at all, is refused.
    let posing = call(
        "cc.c_laptop.p7",
        json!({ "id": pair.watcher_id, "name": "Flight watcher" }),
    );
    let (status, body) = deliver(&base, "host-laptop", "Laptop", &posing).await?;
    assert_eq!(status, 403, "{body}");
    let nameless = call("cc.c_laptop.p8", json!({ "name": "Trip planner" }));
    let (status, body) = deliver(&base, "host-laptop", "Laptop", &nameless).await?;
    assert_eq!(status, 400, "{body}");
    // Nor does ace's own thread ask carry a contract call.
    let honest = call(
        "cc.c_laptop.p9",
        json!({ "id": "a_laptop1", "name": "Trip planner" }),
    );
    let (status, body) = deliver(&base, "ace:thread:host-laptop", "ace", &honest).await?;
    assert_eq!(status, 403, "{body}");

    // A bot of the laptop calls, and the watcher reads it as that machine's.
    let (status, body) = deliver(&base, "host-laptop", "Laptop", &honest).await?;
    assert_eq!(status, 200, "{body}");
    let theirs = pair
        .studio
        .wait_for(&pair.watcher, "contract_ended")
        .await?;
    let delivered: Vec<&Value> = theirs
        .iter()
        .filter(|e| e["type"] == "user_message" && e["from_agent"]["contract"].is_object())
        .collect();
    assert_eq!(delivered.len(), 1, "only the honest call: {delivered:?}");
    assert_eq!(delivered[0]["from_agent"]["id"], "a_laptop1");
    let told = pair.fakes[3].seen()[0].body["messages"].to_string();
    assert!(
        told.contains(r#"from=\"Trip planner\" id=\"a_laptop1\" machine=\"Laptop\""#),
        "{told}"
    );
    Ok(())
}

/// The studio's watcher is a newer version whose output may name the airline, installed as
/// `installing` makes it of that recipe; the laptop's planner holds the older contract.
async fn older_caller_reads_a_newer_field(installing: impl FnOnce(&Value) -> Value) -> Result {
    let mut newer = watcher();
    newer["contracts"][0]["output"]["properties"]["airline"] =
        json!({ "type": "string", "maxLength": 40 });
    let newer = installing(&newer);
    let pair = pair(
        vec![
            calls_studio(),
            Script::reply("Asked the studio."),
            Script::reply("$182."),
        ],
        |call| {
            vec![
                returns(
                    "w1",
                    call,
                    json!({ "fare": 182, "currency": "USD", "airline": "Buddha Air" }),
                ),
                Script::reply("Sent."),
            ]
        },
        newer,
    )
    .await?;
    // The laptop holds the older version, without the airline.
    *pair
        .fleet
        .unlisted_output_field
        .lock()
        .map_err(|e| e.to_string())? = Some("airline".to_owned());
    pair.laptop.say(&pair.planner, "Cheapest fare?").await?;
    let events = pair.laptop.wait_for(&pair.planner, "job_finished").await?;
    let finished = of_type(&events, "job_finished");
    assert_eq!(finished[0]["is_error"], false, "{events:?}");
    let content = text(&finished[0]["content"]);
    assert!(content.contains("\"fare\": 182"), "{content}");
    assert!(content.contains("Buddha Air"), "{content}");
    Ok(())
}

#[tokio::test]
async fn a_caller_with_an_older_contract_reads_an_output_field_a_newer_one_added() -> Result {
    older_caller_reads_a_newer_field(|recipe| {
        let mut body = install();
        body["recipe"] = recipe.clone();
        body
    })
    .await
}

#[tokio::test]
async fn a_caller_reads_a_newer_output_field_of_a_contract_whose_schemas_are_in_a_file() -> Result {
    older_caller_reads_a_newer_field(from_schema_file).await
}
