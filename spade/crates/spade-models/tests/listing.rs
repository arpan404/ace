//! An endpoint's own model list, read over real HTTP from a local fake.

use std::time::Duration;

use serde_json::json;
use spade_models::{Catalog, Endpoint, Format, Keys, ListBounds, ModelError, Models};
use spade_testkit::FakeModelList;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

const KEY: &str = "sk-listing-secret";

fn endpoint(root: &str, format: Format) -> Endpoint {
    Endpoint {
        id: "mine".into(),
        name: "Mine".into(),
        format,
        base_url: root.to_owned(),
        needs_key: true,
        key_env: None,
        headers: vec![("x-team".into(), "spade".into())],
        session_header: None,
        models: Vec::new(),
    }
}

fn models(endpoint: Endpoint, bounds: ListBounds) -> Result<Models> {
    let presets = Catalog::from_json(&json!({ "endpoints": [] }).to_string())?;
    let models = Models::new(presets, Keys::new(|_| Some(KEY.to_owned())), "9.9.9")?
        .with_listing_bounds(bounds);
    models.set_endpoints(vec![endpoint]);
    Ok(models)
}

#[tokio::test]
async fn an_openai_endpoint_lists_its_models_with_a_bearer_key() -> Result {
    let body = json!({ "object": "list", "data": [
        { "id": "kimi", "context_length": 262144 }, { "id": "vendor/glm" }, { "bad": true }
    ]});
    let fake = FakeModelList::start(200, body.to_string(), Duration::ZERO).await?;
    let models = models(
        endpoint(&fake.root, Format::OpenAiChat),
        ListBounds::default(),
    )?;
    let listed = models.list("mine").await?;
    let ids: Vec<_> = listed.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["kimi", "vendor/glm"]);
    let seen = fake.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/models");
    assert_eq!(
        seen[0].key.as_deref(),
        Some(format!("Bearer {KEY}").as_str())
    );
    assert!(
        seen[0]
            .headers
            .iter()
            .any(|(k, v)| k == "x-team" && v == "spade")
    );
    assert!(
        seen[0]
            .headers
            .iter()
            .any(|(k, v)| k == "user-agent" && v == "spade/9.9.9")
    );
    Ok(())
}

#[tokio::test]
async fn an_anthropic_endpoint_lists_its_models_with_its_own_headers() -> Result {
    let body = json!({ "data": [
        { "type": "model", "id": "claude-haiku-5-5", "display_name": "Claude Haiku 5.5" }
    ], "has_more": false });
    let fake = FakeModelList::start(200, body.to_string(), Duration::ZERO).await?;
    let models = models(
        endpoint(&fake.root, Format::Anthropic),
        ListBounds::default(),
    )?;
    let listed = models.list("mine").await?;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name.as_deref(), Some("Claude Haiku 5.5"));
    let seen = &fake.seen()[0];
    assert!(seen.path.starts_with("/models"));
    let header = |name: &str| {
        seen.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    assert_eq!(header("x-api-key").as_deref(), Some(KEY));
    assert_eq!(header("anthropic-version").as_deref(), Some("2023-06-01"));
    assert_eq!(header("authorization"), None);
    Ok(())
}

#[tokio::test]
async fn an_oversized_or_slow_answer_is_refused_in_one_line_without_the_key() -> Result {
    let huge = json!({ "data": (0..5000).map(|n| json!({ "id": format!("model-{n}") })).collect::<Vec<_>>() });
    let fake = FakeModelList::start(200, huge.to_string(), Duration::ZERO).await?;
    let bounds = ListBounds {
        max_bytes: 10_000,
        ..ListBounds::default()
    };
    let error = models(endpoint(&fake.root, Format::OpenAiChat), bounds)?
        .list("mine")
        .await;
    assert!(
        matches!(&error, Err(ModelError::Listing { message, .. }) if message.contains("larger")),
        "{error:?}"
    );

    let slow = FakeModelList::start(200, r#"{"data":[]}"#, Duration::from_secs(5)).await?;
    let bounds = ListBounds {
        timeout: Duration::from_millis(200),
        ..ListBounds::default()
    };
    let started = std::time::Instant::now();
    let error = models(endpoint(&slow.root, Format::OpenAiChat), bounds)?
        .list("mine")
        .await;
    assert!(started.elapsed() < Duration::from_secs(3));
    let text = error.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(text.contains("too long"), "{text}");

    // The endpoint echoes the key back in its error: it is cut out.
    let echo = json!({ "error": { "message": format!("invalid key {KEY}\nretry") } });
    let refusing = FakeModelList::start(401, echo.to_string(), Duration::ZERO).await?;
    let error = models(
        endpoint(&refusing.root, Format::OpenAiChat),
        ListBounds::default(),
    )?
    .list("mine")
    .await;
    let text = error.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(
        text.contains("401") && !text.contains(KEY) && !text.contains('\n'),
        "{text}"
    );
    Ok(())
}

#[tokio::test]
async fn a_model_nobody_saved_gets_preset_facts_or_defaults() -> Result {
    let presets = Catalog::from_json(&json!({ "endpoints": [{ "id": "p", "name": "P",
        "format": "openai-chat", "base_url": "https://p.example/",
        "models": [{ "id": "known", "name": "Known", "context": 9000, "capabilities": ["images"] }] }] })
        .to_string())?;
    let models = Models::new(presets, Keys::new(|_| None), "9.9.9")?;
    models.set_endpoints(vec![endpoint("http://127.0.0.1:9/", Format::OpenAiChat)]);
    let known = models.resolve("mine/known").map(|(_, m)| m.context);
    assert_eq!(known, Some(Some(9000)));
    let typed = models
        .resolve("mine/vendor/odd")
        .map(|(_, m)| (m.id, m.context));
    assert_eq!(typed, Some(("vendor/odd".to_owned(), Some(128_000))));
    assert!(
        models.resolve("p/known").is_none(),
        "only the person's endpoints are called"
    );
    Ok(())
}
