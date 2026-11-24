//! A key read that waits on the keychain (a prompt nobody answers) holds up only the call that
//! needs that key, never the server's async workers or other agents.

mod support;

use std::time::Duration;

use serde_json::json;
use spade_testkit::{FakeProvider, Script};
use support::{Gate, Options, Result, Spade};

// One worker: a key read done on it would stop everything else.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn a_stuck_key_read_for_one_agent_does_not_stop_another_on_a_keyless_endpoint() -> Result {
    let gate = Gate::default();
    let spade = Spade::start_with(
        vec![Script::reply("unused")],
        Vec::new(),
        Options {
            keychain_gate: Some(gate.clone()),
            keychain_gate_for: Some("slow"),
            ..Options::default()
        },
    )
    .await?;
    let open_at_end = OpenOnDrop(gate);
    let slow_fake = FakeProvider::start("Never reached.").await?;
    let local_fake = FakeProvider::start("Local answers.").await?;
    for (name, root, needs_key) in [
        ("Slow", &slow_fake.root, true),
        ("Local", &local_fake.root, false),
    ] {
        let (status, body) = spade
            .post(
                "/v1/endpoints",
                json!({ "name": name, "format": "openai-chat", "base_url": root, "needs_key": needs_key }),
            )
            .await?;
        assert_eq!(status, 201, "{body}");
    }
    let conversation = |agent: &serde_json::Value| {
        agent["agent"]["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    };
    let (_, stuck) = spade
        .post("/v1/agents", json!({ "name": "Stuck", "model": "slow/m" }))
        .await?;
    let (_, free) = spade
        .post("/v1/agents", json!({ "name": "Free", "model": "local/m" }))
        .await?;
    // A plain thread opens the gate after a while whatever happens, so a held-up runtime (whose
    // own timers stall with it) still comes back and the test fails instead of hanging.
    let release = open_at_end.0.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        release.open();
    });
    let asked = std::time::Instant::now();
    spade.say(&conversation(&stuck), "Hello?").await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    spade.say(&conversation(&free), "Hello?").await?;
    let answered = spade
        .wait_for(&conversation(&free), "reply_finished")
        .await?;
    assert!(
        asked.elapsed() < Duration::from_secs(3),
        "the other agent was held up by a stuck key read for {:?}",
        asked.elapsed()
    );
    assert!(
        answered
            .iter()
            .any(|e| e["type"] == "reply_finished" && e["text"] == "Local answers.")
    );
    drop(open_at_end);
    Ok(())
}

/// The fake endpoint as `/v1/models` lists it, and whether any key was still pending.
async fn listed(spade: &Spade) -> Result<(serde_json::Value, serde_json::Value)> {
    let (status, body) =
        tokio::time::timeout(Duration::from_secs(2), spade.get("/v1/models")).await??;
    assert_eq!(status, 200, "{body}");
    let fake = body["endpoints"]
        .as_array()
        .and_then(|list| list.iter().find(|e| e["id"] == "fake"))
        .cloned()
        .unwrap_or_default();
    Ok((fake, body["keys_pending"].clone()))
}

#[tokio::test]
async fn the_model_list_answers_at_once_while_the_keychain_waits_on_a_prompt() -> Result {
    let gate = Gate::default();
    gate.open();
    let spade = Spade::start_with(
        vec![Script::reply("unused")],
        Vec::new(),
        Options {
            keychain_read_gate: Some(gate.clone()),
            ..Options::default()
        },
    )
    .await?;
    let open_at_end = OpenOnDrop(gate);
    spade.store_key_directly("fake", "sk-fake")?;
    // Spade has started; now the keychain puts up a prompt nobody answers yet.
    open_at_end.0.close();
    let (fake, pending) = listed(&spade).await?;
    assert_eq!(pending, true, "{fake}");
    assert!(fake["key_set"].is_null(), "not known yet: {fake}");
    assert!(fake["key_source"].is_null(), "{fake}");
    assert!(
        fake["models"].as_array().is_some_and(|m| !m.is_empty()),
        "{fake}"
    );
    // The person answers the prompt: a later list knows.
    open_at_end.0.open();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let (fake, pending) = listed(&spade).await?;
        if pending == false {
            assert_eq!(fake["key_set"], true, "{fake}");
            assert_eq!(fake["key_source"], "keychain", "{fake}");
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the keychain's answer never showed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

/// A gateway's token (Cloudflare AI Gateway's `cf-aig-authorization`) is a second secret kept in
/// the keychain: it goes out with every call, never into the endpoint's stored headers, and it
/// goes when the endpoint or the token does.
#[tokio::test]
async fn a_gateway_token_stays_in_the_keychain_and_rides_every_call() -> Result {
    let spade = Spade::start(vec![Script::reply("through the gateway")], Vec::new()).await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Gateway", "format": "openai-chat", "base_url": spade.fake.root }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    spade
        .put("/v1/keys/gateway", json!({ "key": "sk-upstream" }))
        .await?;
    let (status, body) = spade
        .put(
            "/v1/keys/gateway/gateway",
            json!({ "token": "cf-token-123" }),
        )
        .await?;
    assert_eq!(status, 204, "{body}");
    assert_eq!(
        spade.keys.gateway_token("gateway")?,
        Some("cf-token-123".to_owned()),
        "the token is in the keychain"
    );
    let (_, shown) = spade.get("/v1/models").await?;
    let gateway = shown["endpoints"]
        .as_array()
        .and_then(|all| all.iter().find(|e| e["id"] == "gateway"))
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        gateway["gateway_token_set"], true,
        "the app can show, replace and remove it: {gateway}"
    );
    // Nowhere else: the endpoint keeps its key's place, not the token.
    let (_, models) = spade.get("/v1/models").await?;
    let shown = models["endpoints"]
        .as_array()
        .and_then(|all| all.iter().find(|e| e["id"] == "gateway"))
        .cloned()
        .unwrap_or_default();
    assert_eq!(shown["header_names"], json!([]), "{shown}");
    assert!(!models.to_string().contains("cf-token-123"), "{models}");

    let (status, body) = spade
        .post(
            "/v1/endpoints/gateway/models",
            json!({ "id": "m", "name": "M" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let (status, bot) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Caller", "model": "gateway/m" }),
        )
        .await?;
    assert_eq!(status, 201, "{bot}");
    let conversation = bot["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    let call = spade
        .fake
        .seen()
        .into_iter()
        .find(|s| s.path.ends_with("/chat/completions"))
        .ok_or("no call reached the gateway")?;
    assert_eq!(call.key.as_deref(), Some("Bearer sk-upstream"));
    let header = call
        .headers
        .iter()
        .find(|(name, _)| name == "cf-aig-authorization")
        .map(|(_, value)| value.clone());
    assert_eq!(header.as_deref(), Some("Bearer cf-token-123"));

    // A token belongs to the gateway it was set for: the host cannot change under it.
    let (status, body) = spade
        .patch(
            "/v1/endpoints/gateway",
            json!({ "base_url": "https://elsewhere.example/v1/" }),
        )
        .await?;
    assert_eq!(status, 409, "{body}");

    // Removing the token stops the header; removing the endpoint takes the token with it.
    let (status, _) = spade.delete("/v1/keys/gateway/gateway").await?;
    assert_eq!(status, 204);
    assert_eq!(spade.keys.gateway_token("gateway")?, None);
    let (_, shown) = spade.get("/v1/models").await?;
    let gateway = shown["endpoints"]
        .as_array()
        .and_then(|all| all.iter().find(|e| e["id"] == "gateway"))
        .cloned()
        .unwrap_or_default();
    assert_eq!(gateway["gateway_token_set"], false);
    let (status, body) = spade
        .put("/v1/keys/openrouter/gateway", json!({ "token": "unused" }))
        .await?;
    assert_eq!(
        status, 404,
        "a token is only for an endpoint that exists: {body}"
    );
    // An endpoint's token goes with the endpoint.
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Spare", "format": "openai-chat", "base_url": spade.fake.root }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    spade
        .put("/v1/keys/spare/gateway", json!({ "token": "cf-spare" }))
        .await?;
    assert_eq!(
        spade.keys.gateway_token("spare")?,
        Some("cf-spare".to_owned())
    );
    let (status, body) = spade.delete("/v1/endpoints/spare").await?;
    assert_eq!(status, 204, "{body}");
    assert_eq!(spade.keys.gateway_token("spare")?, None);
    Ok(())
}

struct OpenOnDrop(Gate);

impl Drop for OpenOnDrop {
    fn drop(&mut self) {
        self.0.open();
    }
}
