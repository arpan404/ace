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
