//! Spade listens at once, whatever the keychain does: a keychain read can block for many seconds
//! (a prompt for a re-signed binary), and nothing before bind may wait on it.

mod support;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_models::Catalog;
use spade_testkit::Script;
use support::{Gate, Options, Result, Spade};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_a_keychain_that_blocks_spade_still_answers_health_at_once() -> Result {
    // What starting takes on this machine with a keychain that answers at once, so the bound
    // below is about the keychain, not about a slow machine.
    let usual = Instant::now();
    drop(Spade::start(vec![Script::reply("unused")], Vec::new()).await?);
    let usual = usual.elapsed();
    let started = Instant::now();
    let spade = Spade::start_with(
        vec![
            Script::reply("Hello."),
            Script::reply("").plain(r#"{"title":"Hi"}"#),
        ],
        Vec::new(),
        Options {
            // Longer than every bound below, so waiting for the keychain fails each of them;
            // the bounds leave a slow machine seconds of room.
            keychain_delay: Some(KEYCHAIN_DELAY),
            ..Options::default()
        },
    )
    .await?;
    let health = spade
        .http
        .get(format!("{}/health", spade.base))
        .timeout(AT_ONCE)
        .send()
        .await?;
    assert_eq!(health.status().as_u16(), 200);
    assert!(
        started.elapsed() < usual + AT_ONCE,
        "listening took {:?}",
        started.elapsed()
    );

    // The API answers meanwhile too.
    let asked = Instant::now();
    let (status, _) = spade.get("/v1/agents").await?;
    assert_eq!(status, 200);
    assert!(asked.elapsed() < AT_ONCE, "{:?}", asked.elapsed());

    // Once the keychain answers, setup finishes: Spade exists and agents work.
    tokio::time::timeout(Duration::from_secs(30), spade.engine.settled()).await?;
    let (_, list) = spade.get("/v1/agents").await?;
    assert_eq!(
        list["agents"][0]["kind"],
        json!("main"),
        "Spade is created once settled"
    );
    let conversation = spade.ask("Hi").await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "reply_finished" && e["text"] == "Hello.")
    );
    Ok(())
}

/// One keychain read in the test where every read is slow.
const KEYCHAIN_DELAY: Duration = Duration::from_millis(2_500);
/// What "at once" allows, beyond what starting usually takes: short of [`KEYCHAIN_DELAY`].
const AT_ONCE: Duration = Duration::from_secs(2);

/// Opens the gate when dropped, so a failing test never leaves a keychain read waiting forever.
struct OpenOnDrop(Gate);

impl Drop for OpenOnDrop {
    fn drop(&mut self) {
        self.0.open();
    }
}

async fn blocked(scripts: Vec<Script>, options: Options) -> Result<(Spade, OpenOnDrop)> {
    let gate = Gate::default();
    let spade = Spade::start_with(
        scripts,
        Vec::new(),
        Options {
            keychain_gate: Some(gate.clone()),
            ..options
        },
    )
    .await?;
    Ok((spade, OpenOnDrop(gate)))
}

async fn patch(spade: &Spade, path: &str, body: Value) -> Result<u16> {
    Ok(spade
        .http
        .patch(format!("{}{path}", spade.base))
        .bearer_auth(support::TOKEN)
        .json(&body)
        .send()
        .await?
        .status()
        .as_u16())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spade_is_listed_from_the_first_answer_and_keeps_a_model_the_person_chose_meanwhile()
-> Result {
    let (spade, gate) = blocked(vec![Script::reply("unused")], Options::default()).await?;
    let (_, list) = spade.get("/v1/agents").await?;
    let main = list["agents"][0].clone();
    assert_eq!(
        main["kind"], "main",
        "Spade is there before setup has read a key"
    );
    let id = main["id"].as_str().unwrap_or_default().to_owned();

    // The person adds an endpoint and gives Spade a model on it while setup still waits.
    let (status, _) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Mine", "format": "openai-chat", "base_url": "http://127.0.0.1:9",
                    "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "endpoint changes are not held up by setup");
    assert_eq!(
        patch(
            &spade,
            &format!("/v1/agents/{id}"),
            json!({ "model": "mine/x" })
        )
        .await?,
        200
    );
    gate.0.open();
    tokio::time::timeout(Duration::from_secs(10), spade.engine.settled()).await?;
    let (_, list) = spade.get("/v1/agents").await?;
    assert_eq!(
        list["agents"][0]["model"], "mine/x",
        "setup never replaces the person's choice"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_endpoint_made_while_setup_waits_is_kept_and_the_rest_is_still_adopted() -> Result {
    // `fake` is shipped and unedited, so adopting it waits on the keychain; the other two are
    // the person's own.
    let file = Catalog::from_json(
        &json!({ "endpoints": [
            { "id": "fake", "name": "Fake", "format": "openai-chat", "base_url": "http://127.0.0.1:9/",
              "key": { "env": "FAKE_KEY" }, "models": [] },
            { "id": "my-local", "name": "My local", "format": "openai-chat",
              "base_url": "http://127.0.0.1:7/", "models": [] },
            { "id": "other-local", "name": "Other local", "format": "openai-chat",
              "base_url": "http://127.0.0.1:8/", "models": [] }
        ]})
        .to_string(),
    )?;
    let (spade, gate) = blocked(
        vec![Script::reply("unused")],
        Options {
            adopt: Some(file),
            ..Options::default()
        },
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": "My local", "format": "openai-chat", "base_url": "http://127.0.0.2:7",
                    "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["endpoint"]["id"], "my-local");
    gate.0.open();
    tokio::time::timeout(Duration::from_secs(10), spade.engine.settled()).await?;
    let (_, models) = spade.get("/v1/models").await?;
    let find = |id: &str| -> Value {
        models["endpoints"]
            .as_array()
            .and_then(|e| e.iter().find(|e| e["id"] == id).cloned())
            .unwrap_or_default()
    };
    assert_eq!(
        find("my-local")["base_url"],
        "http://127.0.0.2:7/",
        "the person's, not the old file's"
    );
    assert_eq!(find("other-local")["base_url"], "http://127.0.0.1:8/");
    assert_eq!(find("fake")["id"], "fake");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_keychain_that_never_answers_delays_work_only_until_the_deadline_then_heals() -> Result {
    let (spade, gate) = blocked(
        vec![
            Script::reply("Healed."),
            Script::reply("").plain(r#"{"title":"T"}"#),
        ],
        Options {
            settle_deadline: Duration::from_millis(300),
            ..Options::default()
        },
    )
    .await?;
    let health = |spade: &Spade| {
        let request = spade.http.get(format!("{}/health", spade.base));
        async move { Result::<Value>::Ok(request.send().await?.json().await?) }
    };
    assert_eq!(health(&spade).await?["starting"], true);

    // Work opens after the deadline though the keychain still has not answered.
    let (_, list) = spade.get("/v1/agents").await?;
    let conversation = list["agents"][0]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Anyone there?").await?;
    spade.wait_for(&conversation, "reply_started").await?;
    let now = health(&spade).await?;
    assert_eq!(
        (&now["starting"], &now["starting_reason"]),
        (&json!(true), &json!("waiting for the keychain"))
    );
    let (_, models) = spade.get("/v1/models").await?;
    assert_eq!(models["starting_reason"], "waiting for the keychain");
    // With no endpoint set up yet, that reply fails; waited for before the keychain answers,
    // so a slow machine can't reach the model only after setup finished.
    spade.wait_for(&conversation, "reply_failed").await?;
    // The failed turn is then named, from its first message while no endpoint is set up; were
    // it named after the keychain answered, the title would take the reply's model answer.
    spade.wait_for(&conversation, "renamed").await?;

    // The keychain answers: setup finishes by itself, no restart.
    gate.0.open();
    tokio::time::timeout(Duration::from_secs(10), spade.engine.settled()).await?;
    let now = health(&spade).await?;
    assert_eq!(
        (&now["starting"], &now["starting_reason"]),
        (&json!(false), &Value::Null)
    );
    // The failed reply may have finished too; the next reply is the one after those.
    let finished = |events: &[Value]| {
        events
            .iter()
            .filter(|e| e["type"] == "reply_finished")
            .count()
    };
    let before = finished(&spade.events(&conversation).await?);
    spade.say(&conversation, "Now?").await?;
    let events = spade
        .wait_for_count(&conversation, "reply_finished", before + 1)
        .await?;
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "reply_finished" && e["text"] == "Healed."),
        "{:?}",
        support::types(&events)
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_model_save_goes_through_while_another_endpoints_key_read_is_stuck() -> Result {
    let (spade, gate) = blocked(vec![Script::reply("unused")], Options::default()).await?;
    for (name, url) in [
        ("Stuck", "http://127.0.0.1:7"),
        ("Free", "http://127.0.0.1:8"),
    ] {
        let (status, body) = spade
            .post(
                "/v1/endpoints",
                json!({ "name": name, "format": "openai-chat", "base_url": url, "needs_key": false }),
            )
            .await?;
        assert_eq!(status, 201, "{body}");
    }
    // Moving `stuck` to another host reads its key, and that read waits on the keychain.
    let moving = {
        let (http, base) = (spade.http.clone(), spade.base.clone());
        tokio::spawn(async move {
            http.patch(format!("{base}/v1/endpoints/stuck"))
                .bearer_auth(support::TOKEN)
                .json(&json!({ "base_url": "http://127.0.0.9:7" }))
                .send()
                .await
                .map(|r| r.status().as_u16())
        })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    let saved = tokio::time::timeout(
        Duration::from_secs(2),
        spade.post("/v1/endpoints/free/models", json!({ "id": "llama" })),
    )
    .await;
    assert!(
        matches!(&saved, Ok(Ok((200, _)))),
        "the save waited on another endpoint's keychain read: {:?}",
        saved.map(|r| r.map(|(s, _)| s))
    );
    gate.0.open();
    assert_eq!(moving.await??, 200);
    Ok(())
}

fn seed_keyed_endpoint(store: &spade_store::Store) -> spade_store::Result<()> {
    // Stored, but its key is not set: the database alone cannot tell, so Spade's first model
    // (picked before keys can be read) lands here and setup must correct it.
    store.insert_endpoint(&spade_store::StoredEndpoint {
        id: "keyed".into(),
        name: "Keyed".into(),
        format: "openai-chat".into(),
        base_url: "http://127.0.0.1:9/".into(),
        headers: Vec::new(),
        session_header: None,
        needs_key: true,
        key_env: None,
        preset: None,
        created_ms: 1,
        models: vec![spade_store::StoredModel {
            id: "k".into(),
            name: None,
            context: None,
            capabilities: None,
            source: "typed".into(),
        }],
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_change_to_spades_model_leaves_the_placeholder_for_setup_to_correct() -> Result {
    let (spade, gate) = blocked(
        vec![Script::reply("unused")],
        Options {
            seed: Some(seed_keyed_endpoint),
            ..Options::default()
        },
    )
    .await?;
    let (_, list) = spade.get("/v1/agents").await?;
    let main = list["agents"][0].clone();
    assert_eq!(main["model"], "keyed/k", "the placeholder");
    let id = main["id"].as_str().unwrap_or_default().to_owned();
    assert_eq!(
        patch(
            &spade,
            &format!("/v1/agents/{id}"),
            json!({ "model": "nowhere/x" })
        )
        .await?,
        400
    );
    gate.0.open();
    tokio::time::timeout(Duration::from_secs(10), spade.engine.settled()).await?;
    let (_, list) = spade.get("/v1/agents").await?;
    assert_eq!(
        list["agents"][0]["model"], "fake/m",
        "setup still gave Spade a usable model"
    );
    Ok(())
}
