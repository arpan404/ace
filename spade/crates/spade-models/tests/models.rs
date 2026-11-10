//! Calls go through the real SDK and HTTP to a local fake gateway.

mod fake_provider;

use fake_provider::FakeProvider;
use futures_util::StreamExt;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

use spade_models::{
    ApiKey, Catalog, Delta, Gateway, ModelError, Models, ModelsConfig, Prompt, Usage,
};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

/// The catalogue Spade ships, so these tests also cover its routes.
fn shipped_catalog() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/models.json")
}

fn config(gateway: Gateway, fake: &FakeProvider) -> ModelsConfig {
    ModelsConfig {
        gateway,
        key: ApiKey::new("test-key"),
        root: Some(fake.root.clone()),
        catalog: shipped_catalog(),
    }
}

fn models(gateway: Gateway, fake: &FakeProvider) -> Result<Models> {
    let config = config(gateway, fake);
    let catalog = Catalog::load(&config.catalog)?;
    Ok(Models::new(config, catalog)?)
}

fn only_request(fake: &FakeProvider) -> Result<fake_provider::Seen> {
    let mut seen = fake.seen();
    assert_eq!(seen.len(), 1, "expected one request, got {seen:?}");
    seen.pop().ok_or_else(|| "no request".into())
}

#[derive(Debug, Deserialize, JsonSchema, PartialEq)]
struct Verdict {
    relevant: bool,
    score: u8,
}

#[tokio::test]
async fn opencode_go_sends_openai_style_models_to_its_openai_endpoint() -> Result {
    let fake = FakeProvider::start("Hello from Kimi").await?;
    let reply = models(Gateway::OpenCodeGo, &fake)?
        .chat("kimi-k3.1-pro", &Prompt::ask("hi"))
        .await?;

    assert_eq!(reply.text, "Hello from Kimi");
    assert_eq!(reply.model, "kimi-k3.1-pro");
    assert_eq!(
        reply.usage,
        Usage {
            input_tokens: Some(11),
            output_tokens: Some(7)
        }
    );
    let request = only_request(&fake)?;
    assert_eq!(request.path, "/openai/v1/chat/completions");
    assert_eq!(request.key.as_deref(), Some("Bearer test-key"));
    assert_eq!(request.body["model"], "kimi-k3.1-pro");
    Ok(())
}

#[tokio::test]
async fn opencode_go_sends_claude_haiku_through_its_anthropic_endpoint() -> Result {
    let fake = FakeProvider::start("Hello from Haiku").await?;
    let reply = models(Gateway::OpenCodeGo, &fake)?
        .chat("claude-haiku-5-5", &Prompt::ask("hi"))
        .await?;

    assert_eq!(reply.text, "Hello from Haiku");
    let request = only_request(&fake)?;
    assert_eq!(request.path, "/anthropic/v1/messages");
    assert_eq!(request.key.as_deref(), Some("test-key"));
    assert_eq!(request.body["model"], "claude-haiku-5-5");
    Ok(())
}

#[tokio::test]
async fn openrouter_calls_use_openrouter_model_ids() -> Result {
    let fake = FakeProvider::start("Hello from Sonnet").await?;
    models(Gateway::OpenRouter, &fake)?
        .chat("claude-sonnet-5-5", &Prompt::ask("hi"))
        .await?;

    let request = only_request(&fake)?;
    assert_eq!(request.path, "/chat/completions");
    assert_eq!(request.body["model"], "anthropic/claude-sonnet-5.5");
    Ok(())
}

#[tokio::test]
async fn instructions_and_history_are_sent_in_order() -> Result {
    let fake = FakeProvider::start("ok").await?;
    let prompt = Prompt::ask("first")
        .system("Be brief.")
        .spade("noted")
        .person("second");
    models(Gateway::OpenCodeGo, &fake)?
        .chat("glm-5.3", &prompt)
        .await?;

    let request = only_request(&fake)?;
    let turns: Vec<(Value, Value)> = request.body["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .map(|m| (m["role"].clone(), m["content"].clone()))
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(
        turns,
        vec![
            (json!("system"), json!("Be brief.")),
            (json!("user"), json!("first")),
            (json!("assistant"), json!("noted")),
            (json!("user"), json!("second")),
        ]
    );
    Ok(())
}

#[tokio::test]
async fn typed_output_asks_for_the_schema_and_returns_the_type() -> Result {
    let fake = FakeProvider::start(r#"{"relevant": true, "score": 7}"#).await?;
    let verdict: Verdict = models(Gateway::OpenCodeGo, &fake)?
        .generate("glm-5.3", &Prompt::ask("Is this relevant?"))
        .await?;

    assert_eq!(
        verdict,
        Verdict {
            relevant: true,
            score: 7
        }
    );
    let request = only_request(&fake)?;
    assert_eq!(request.body["response_format"]["type"], "json_schema");
    assert_eq!(
        request.body["response_format"]["json_schema"]["name"],
        "Verdict"
    );
    Ok(())
}

#[tokio::test]
async fn typed_output_works_through_the_anthropic_protocol() -> Result {
    let fake = FakeProvider::start(r#"{"relevant": false, "score": 2}"#).await?;
    let verdict: Verdict = models(Gateway::OpenCodeGo, &fake)?
        .generate("claude-haiku-5-5", &Prompt::ask("Is this relevant?"))
        .await?;

    assert_eq!(
        verdict,
        Verdict {
            relevant: false,
            score: 2
        }
    );
    Ok(())
}

#[tokio::test]
async fn typed_output_that_does_not_match_is_an_error() -> Result {
    let fake = FakeProvider::start(r#"{"relevant": "maybe"}"#).await?;
    let verdict = models(Gateway::OpenCodeGo, &fake)?
        .generate::<Verdict>("glm-5.3", &Prompt::ask("Is this relevant?"))
        .await;

    assert!(
        matches!(&verdict, Err(ModelError::Shape { model, .. }) if model == "glm-5.3"),
        "{verdict:?}"
    );
    Ok(())
}

async fn streamed(gateway: Gateway, model: &str, fake: &FakeProvider) -> Result<Vec<Delta>> {
    let stream = models(gateway, fake)?
        .stream(model, &Prompt::ask("hi"))
        .await?;
    let deltas: Vec<_> = stream.collect().await;
    Ok(deltas.into_iter().collect::<std::result::Result<_, _>>()?)
}

fn text_of(deltas: &[Delta]) -> String {
    deltas
        .iter()
        .filter_map(|delta| match delta {
            Delta::Text(text) => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn an_openai_style_stream_arrives_in_pieces_and_ends_with_usage() -> Result {
    let fake = FakeProvider::start("Streaming works").await?;
    let deltas = streamed(Gateway::OpenCodeGo, "kimi-k3.1-pro", &fake).await?;

    assert!(
        deltas
            .iter()
            .filter(|d| matches!(d, Delta::Text(_)))
            .count()
            >= 2
    );
    assert_eq!(text_of(&deltas), "Streaming works");
    assert!(matches!(
        deltas.last(),
        Some(Delta::Done {
            usage: Usage {
                output_tokens: Some(7),
                ..
            }
        })
    ));
    Ok(())
}

#[tokio::test]
async fn an_anthropic_stream_arrives_in_pieces_and_ends_with_usage() -> Result {
    let fake = FakeProvider::start("Streaming works").await?;
    let deltas = streamed(Gateway::OpenCodeGo, "claude-haiku-5-5", &fake).await?;

    assert!(
        deltas
            .iter()
            .filter(|d| matches!(d, Delta::Text(_)))
            .count()
            >= 2
    );
    assert_eq!(text_of(&deltas), "Streaming works");
    assert!(matches!(
        deltas.last(),
        Some(Delta::Done {
            usage: Usage {
                output_tokens: Some(7),
                ..
            }
        })
    ));
    Ok(())
}

#[tokio::test]
async fn a_model_outside_the_catalogue_never_reaches_the_network() -> Result {
    let fake = FakeProvider::start("unused").await?;
    let reply = models(Gateway::OpenRouter, &fake)?
        .chat("gpt-5.4", &Prompt::ask("hi"))
        .await;

    assert_eq!(reply, Err(ModelError::UnknownModel("gpt-5.4".to_owned())));
    assert!(fake.seen().is_empty());
    Ok(())
}

#[tokio::test]
async fn a_catalogue_without_defaults_for_the_gateway_is_refused_at_startup() -> Result {
    let fake = FakeProvider::start("unused").await?;
    let catalog = Catalog::from_json(
        r#"{ "defaults": {}, "models": [
            { "id": "glm-5.3", "name": "GLM-5.3", "routes": { "opencode-go": { "model": "glm-5.3" } } }
        ] }"#,
    )?;
    let models = Models::new(config(Gateway::OpenCodeGo, &fake), catalog);
    assert_eq!(
        models.err(),
        Some(ModelError::NoDefaults(Gateway::OpenCodeGo))
    );
    Ok(())
}
