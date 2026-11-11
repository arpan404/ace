//! The person's endpoints and models through the API (ADR 0126): presets adopted, live model
//! lists, saved and typed models, deletion guarded by use, and keys never sent back.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use spade_testkit::{FakeModelList, Script};
use support::{Result, Spade};

const KEY: &str = "sk-never-shown-4417";
const HEADER_VALUE: &str = "team-secret-9921";

async fn endpoint(spade: &Spade, id: &str) -> Result<Value> {
    let (_, models) = spade.get("/v1/models").await?;
    Ok(models["endpoints"]
        .as_array()
        .and_then(|e| e.iter().find(|e| e["id"] == id).cloned())
        .unwrap_or_default())
}

#[tokio::test]
async fn a_shipped_endpoint_that_has_a_key_is_the_persons_from_the_start() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let (_, models) = spade.get("/v1/models").await?;
    let fake = &models["endpoints"][0];
    assert_eq!(fake["id"], "fake");
    assert_eq!(fake["models"][0]["id"], "m");
    assert_eq!(fake["models"][0]["source"], "preset");
    assert_eq!(models["presets"][0]["key_env"], "FAKE_KEY");
    assert_eq!(models["fast_model"], Value::Null);
    Ok(())
}

#[tokio::test]
async fn an_openai_endpoints_models_are_listed_live_and_saved_with_their_facts() -> Result {
    let list = json!({ "data": [
        { "id": "kimi", "context_length": 262144 }, { "id": "glm", "name": "GLM" }, { "nope": 1 }
    ]});
    let fake_list = FakeModelList::start(200, list.to_string(), Duration::ZERO).await?;
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": "My Gateway", "format": "openai-chat", "base_url": fake_list.root,
                    "headers": { "x-team": HEADER_VALUE }, "session_header": "X-Session" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let created = &body["endpoint"];
    assert_eq!(created["id"], "my-gateway");
    assert_eq!(created["header_names"], json!(["x-team"]));
    assert_eq!(created["session_header"], "x-session");
    assert_eq!(
        (&created["key_set"], &created["key_source"]),
        (&json!(false), &Value::Null)
    );

    let (status, body) = spade.get("/v1/endpoints/my-gateway/models").await?;
    assert_eq!(status, 400, "a key is needed first: {body}");
    spade
        .put("/v1/keys/my-gateway", json!({ "key": KEY }))
        .await?;
    let (status, body) = spade.get("/v1/endpoints/my-gateway/models").await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["models"],
        json!([{ "id": "kimi", "context": 262144 }, { "id": "glm", "name": "GLM" }])
    );
    let asked = &fake_list.seen()[0];
    assert_eq!(asked.key.as_deref(), Some(format!("Bearer {KEY}").as_str()));
    assert!(
        asked
            .headers
            .iter()
            .any(|(k, v)| k == "x-team" && v == HEADER_VALUE)
    );

    let (status, body) = spade
        .post("/v1/endpoints/my-gateway/models", json!({ "id": "kimi" }))
        .await?;
    assert_eq!(status, 200, "{body}");
    let (status, body) = spade
        .post(
            "/v1/endpoints/my-gateway/models",
            json!({ "id": "vendor/typed", "capabilities": ["tools", "images"] }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let models = body["endpoint"]["models"].clone();
    assert_eq!(
        models,
        json!([
            { "id": "kimi", "name": "kimi", "context": 262144, "capabilities": ["tools"], "source": "listed" },
            { "id": "vendor/typed", "name": "vendor/typed", "context": 128000,
              "capabilities": ["tools", "images"], "source": "typed" }
        ])
    );
    let (status, _) = spade
        .post(
            "/v1/endpoints/my-gateway/models",
            json!({ "id": "x", "capabilities": ["flying"] }),
        )
        .await?;
    assert_eq!(status, 400);
    let (status, _) = spade
        .delete("/v1/endpoints/my-gateway/models?id=vendor/typed")
        .await?;
    assert_eq!(status, 204);
    let (status, _) = spade
        .delete("/v1/endpoints/my-gateway/models?id=vendor/typed")
        .await?;
    assert_eq!(status, 404);
    Ok(())
}

#[tokio::test]
async fn an_anthropic_endpoint_lists_its_models_with_its_own_key_header() -> Result {
    let list =
        json!({ "data": [{ "id": "claude-haiku-5-5", "display_name": "Claude Haiku 5.5" }] });
    let fake_list = FakeModelList::start(200, list.to_string(), Duration::ZERO).await?;
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Claude", "format": "anthropic", "base_url": fake_list.root }),
        )
        .await?;
    spade.put("/v1/keys/claude", json!({ "key": KEY })).await?;
    let (status, body) = spade.get("/v1/endpoints/claude/models").await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["models"][0]["name"], "Claude Haiku 5.5");
    let asked = &fake_list.seen()[0];
    let header = |name: &str| {
        asked
            .headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    assert_eq!(header("x-api-key").as_deref(), Some(KEY));
    assert_eq!(header("anthropic-version").as_deref(), Some("2023-06-01"));
    Ok(())
}

#[tokio::test]
async fn a_failing_or_slow_endpoint_answers_one_short_line_without_the_key() -> Result {
    let echo = json!({ "error": { "message": format!("bad key {KEY}") } });
    let refusing = FakeModelList::start(401, echo.to_string(), Duration::ZERO).await?;
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Refuser", "format": "openai-chat", "base_url": refusing.root }),
        )
        .await?;
    spade.put("/v1/keys/refuser", json!({ "key": KEY })).await?;
    let (status, body) = spade.get("/v1/endpoints/refuser/models").await?;
    assert_eq!(status, 502);
    let error = body["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("401") && !error.contains(KEY) && !error.contains('\n'),
        "{error}"
    );
    Ok(())
}

#[tokio::test]
async fn an_endpoint_an_agent_uses_cannot_be_deleted_and_no_key_is_ever_answered() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let (_, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Local", "format": "openai-chat", "base_url": "http://127.0.0.1:9",
                    "needs_key": false, "headers": { "x-team": HEADER_VALUE } }),
        )
        .await?;
    assert_eq!(body["endpoint"]["base_url"], "http://127.0.0.1:9/");
    spade.put("/v1/keys/local", json!({ "key": KEY })).await?;
    spade.put("/v1/keys/fake", json!({ "key": KEY })).await?;
    let bot = spade
        .post(
            "/v1/agents",
            json!({ "name": "Helper", "model": "local/llama" }),
        )
        .await?
        .1;
    let (status, body) = spade.delete("/v1/endpoints/local").await?;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["agents"], json!(["Helper"]));

    let mut answers = vec![bot];
    for path in ["/v1/models", "/v1/agents"] {
        answers.push(spade.get(path).await?.1);
    }
    let response = spade
        .http
        .patch(format!("{}/v1/endpoints/local", spade.base))
        .bearer_auth(support::TOKEN)
        .json(&json!({ "name": "Local LLM" }))
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 200);
    answers.push(response.json().await?);
    for answer in &answers {
        let text = answer.to_string();
        assert!(
            !text.contains(KEY) && !text.contains(HEADER_VALUE),
            "{text}"
        );
    }

    let id = answers[0]["agent"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert_eq!(spade.delete(&format!("/v1/agents/{id}")).await?.0, 204);
    assert_eq!(spade.delete("/v1/endpoints/local").await?.0, 204);
    assert_eq!(spade.keys.get("local")?, None, "its key went with it");
    assert_eq!(endpoint(&spade, "local").await?, Value::Null);
    Ok(())
}

#[tokio::test]
async fn a_persons_endpoint_carries_the_conversations_session_id_and_spades_user_agent() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let routed = spade_testkit::FakeProvider::start("Routed.").await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Routed", "format": "openai-chat", "base_url": routed.root,
                    "needs_key": false, "session_header": "x-sess" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    spade
        .put("/v1/settings", json!({ "fast_model": "fake/m" }))
        .await?;
    let (_, agent) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Router", "model": "routed/r" }),
        )
        .await?;
    let conversation = agent["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "One").await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    spade.say(&conversation, "Two").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    let seen = routed.seen();
    assert_eq!(seen.len(), 2);
    for request in &seen {
        let header = |name: &str| {
            request
                .headers
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(header("x-sess").as_deref(), Some(conversation.as_str()));
        assert_eq!(
            header("user-agent"),
            Some(format!("spade/{}", spade_server::home::VERSION))
        );
    }
    Ok(())
}

async fn patch(spade: &Spade, path: &str, body: Value) -> Result<(u16, Value)> {
    let response = spade
        .http
        .patch(format!("{}{path}", spade.base))
        .bearer_auth(support::TOKEN)
        .json(&body)
        .send()
        .await?;
    let status = response.status().as_u16();
    Ok((status, response.json().await.unwrap_or(Value::Null)))
}

#[tokio::test]
async fn moving_an_endpoint_to_another_host_is_refused_while_a_key_or_headers_are_attached()
-> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Gate", "format": "openai-chat", "base_url": "https://gate.example/v1" }),
        )
        .await?;
    spade.put("/v1/keys/gate", json!({ "key": KEY })).await?;
    let (status, body) = patch(
        &spade,
        "/v1/endpoints/gate",
        json!({ "base_url": "https://evil.example/v1" }),
    )
    .await?;
    assert_eq!(status, 409, "{body}");
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|e| e.contains("remove it first")),
        "{body}"
    );
    assert_eq!(
        endpoint(&spade, "gate").await?["base_url"],
        "https://gate.example/v1/"
    );
    // The same host is fine, and so is another once the key is gone.
    let (status, _) = patch(
        &spade,
        "/v1/endpoints/gate",
        json!({ "base_url": "https://gate.example/v2" }),
    )
    .await?;
    assert_eq!(status, 200);
    spade.delete("/v1/keys/gate").await?;
    let (status, _) = patch(
        &spade,
        "/v1/endpoints/gate",
        json!({ "base_url": "https://new.example/v1" }),
    )
    .await?;
    assert_eq!(status, 200);

    spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Team", "format": "openai-chat", "base_url": "http://127.0.0.1:9",
                    "needs_key": false, "headers": { "x-team": HEADER_VALUE } }),
        )
        .await?;
    let (status, _) = patch(
        &spade,
        "/v1/endpoints/team",
        json!({ "base_url": "http://127.0.0.2:9" }),
    )
    .await?;
    assert_eq!(status, 409, "headers stay with their host");
    let (status, body) = patch(
        &spade,
        "/v1/endpoints/team",
        json!({ "base_url": "http://127.0.0.2:9", "headers": {} }),
    )
    .await?;
    assert_eq!(status, 200, "{body}");
    Ok(())
}

#[tokio::test]
async fn a_header_that_carries_a_credential_is_refused_whatever_its_case() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    for headers in [
        json!({ "Authorization": "Bearer x" }),
        json!({ "X-API-Key": "x" }),
        json!({ "api-key": "x" }),
        json!({ "Cookie": "s=1" }),
        json!({ "Proxy-Authorization": "Basic x" }),
    ] {
        let (status, body) = spade
            .post(
                "/v1/endpoints",
                json!({ "name": "Leaky", "format": "openai-chat", "base_url": "https://l.example/", "headers": headers }),
            )
            .await?;
        assert_eq!(status, 400, "{headers}: {body}");
    }
    let (status, _) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Leaky", "format": "openai-chat", "base_url": "https://l.example/",
                    "session_header": "x-api-key" }),
        )
        .await?;
    assert_eq!(status, 400);
    assert_eq!(endpoint(&spade, "leaky").await?, Value::Null);
    Ok(())
}

#[tokio::test]
async fn a_model_on_an_endpoint_costs_its_own_presets_price_not_another_endpoints() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let spare_fake = spade_testkit::FakeProvider::start("Priced.").await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "preset": "spare", "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let (status, body) = patch(
        &spade,
        "/v1/endpoints/spare",
        json!({ "base_url": spare_fake.root }),
    )
    .await?;
    assert_eq!(status, 200, "{body}");
    spade
        .put("/v1/settings", json!({ "fast_model": "spare/s" }))
        .await?;
    let (_, agent) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Spender", "model": "spare/m" }),
        )
        .await?;
    let conversation = agent["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Hi").await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let finished = events
        .iter()
        .find(|e| e["type"] == "reply_finished")
        .cloned()
        .unwrap_or_default();
    // 11 input and 7 output tokens at $100/M each: 1,800 micros (fake's $2/$10 would give 92).
    assert_eq!(finished["cost_micros"], 1800);
    Ok(())
}

#[tokio::test]
async fn a_base_url_that_would_go_somewhere_else_than_it_reads_is_refused() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Gate", "format": "openai-chat", "base_url": "https://gate.example/v1" }),
        )
        .await?;
    spade.put("/v1/keys/gate", json!({ "key": KEY })).await?;
    for sneaky in [
        // Clients send this to evil.example.
        "https://evil.example\\@gate.example/v1",
        "https://evil.example@gate.example/v1",
        "https://user:pass@gate.example/v1",
        "ftp://gate.example/v1",
    ] {
        let (status, body) =
            patch(&spade, "/v1/endpoints/gate", json!({ "base_url": sneaky })).await?;
        assert_eq!(status, 400, "{sneaky}: {body}");
        let (status, _) = spade
            .post(
                "/v1/endpoints",
                json!({ "name": "Other", "format": "openai-chat", "base_url": sneaky }),
            )
            .await?;
        assert_eq!(status, 400, "{sneaky}");
    }
    let (status, _) = patch(
        &spade,
        "/v1/endpoints/gate",
        json!({ "base_url": "https://gate.example:8443/v1" }),
    )
    .await?;
    assert_eq!(status, 409, "another port is another host");
    assert_eq!(
        endpoint(&spade, "gate").await?["base_url"],
        "https://gate.example/v1/"
    );
    Ok(())
}

#[tokio::test]
async fn turning_off_needs_key_does_not_let_a_stored_key_follow_a_host_change() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Gate", "format": "openai-chat", "base_url": "https://gate.example/v1" }),
        )
        .await?;
    spade.put("/v1/keys/gate", json!({ "key": KEY })).await?;
    let (status, _) = patch(&spade, "/v1/endpoints/gate", json!({ "needs_key": false })).await?;
    assert_eq!(status, 200);
    let (status, body) = patch(
        &spade,
        "/v1/endpoints/gate",
        json!({ "base_url": "https://evil.example/v1" }),
    )
    .await?;
    assert_eq!(status, 409, "the key is still stored: {body}");
    // A key bound to an environment variable is the preset host's too.
    let (_, created) = spade
        .post(
            "/v1/endpoints",
            json!({ "preset": "fake", "name": "Fake two" }),
        )
        .await?;
    let id = created["endpoint"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, body) = patch(
        &spade,
        &format!("/v1/endpoints/{id}"),
        json!({ "needs_key": false, "base_url": "https://evil.example/v1" }),
    )
    .await?;
    assert_eq!(status, 409, "{body}");
    Ok(())
}

#[tokio::test]
async fn a_preset_used_for_another_host_does_not_take_the_presets_key_there() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let elsewhere = spade_testkit::FakeProvider::start("Should not be reached.").await?;
    // `fake`'s key comes from FAKE_KEY; this endpoint points at another host.
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "preset": "fake", "name": "Elsewhere", "base_url": elsewhere.root }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["endpoint"]["key_set"], false);
    let (_, agent) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Away", "model": "elsewhere/m" }),
        )
        .await?;
    let conversation = agent["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade
        .put("/v1/settings", json!({ "fast_model": "fake/m" }))
        .await?;
    spade.say(&conversation, "Hi").await?;
    let events = spade.wait_for(&conversation, "reply_failed").await?;
    let failed = events
        .iter()
        .find(|e| e["type"] == "reply_failed")
        .cloned()
        .unwrap_or_default();
    assert!(
        failed["error"]
            .as_str()
            .is_some_and(|e| e.contains("no key")),
        "{failed}"
    );
    assert!(
        elsewhere
            .seen()
            .iter()
            .all(|s| s.key.as_deref() != Some("Bearer fake-key")),
        "the preset's key never went to the other host"
    );
    Ok(())
}
