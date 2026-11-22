//! A prompt's reasoning effort reaches the endpoint in its own format, through the real SDK and
//! HTTP, and an endpoint that refuses it still answers (ADR 0213).

use futures_util::StreamExt;
use serde_json::{Value, json};
use spade_models::{Catalog, Delta, Effort, Keys, Models, Prompt};
use spade_testkit::{FakeProvider, Script};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn models(fake: &FakeProvider) -> Result<Models> {
    let json = json!({
        "roles": { "main": "chat/kimi", "fast": "chat/kimi", "deep": "chat/kimi" },
        "endpoints": [
            { "id": "chat", "name": "Chat", "format": "openai-chat", "base_url": fake.root,
              "key": { "env": "K" }, "models": [ { "id": "kimi", "name": "Kimi" },
                                                  { "id": "o3-high", "name": "O3 high" } ] },
            { "id": "resp", "name": "Responses", "format": "openai-responses", "base_url": fake.root,
              "key": { "env": "K" }, "models": [ { "id": "gpt", "name": "GPT" } ] },
            { "id": "msgs", "name": "Messages", "format": "anthropic", "base_url": fake.root,
              "key": { "env": "K" }, "models": [ { "id": "claude-sonnet-4-5", "name": "Sonnet" } ] }
        ]
    });
    Ok(Models::new(
        Catalog::from_json(&json.to_string())?,
        Keys::new(|_| Some("key".to_owned())),
        "test",
    )?)
}

fn bodies(fake: &FakeProvider) -> Vec<Value> {
    fake.seen().into_iter().map(|s| s.body).collect()
}

async fn streamed(models: &Models, reference: &str, prompt: &Prompt) -> Result<String> {
    let mut stream = Box::pin(models.stream(reference, prompt).await?);
    let mut text = String::new();
    while let Some(delta) = stream.next().await {
        match delta? {
            Delta::Text(piece) => text.push_str(&piece),
            Delta::Done { .. } => return Ok(text),
            _ => {}
        }
    }
    Err("the stream ended without Done".into())
}

#[tokio::test]
async fn a_chat_endpoint_is_asked_for_the_effort_with_room_to_think_beside_the_answer() -> Result {
    let fake = FakeProvider::start("ok").await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("hi").max_tokens(4_000).effort(Effort::Medium);
    models.chat("chat/kimi", &prompt).await?;
    let body = &bodies(&fake)[0];
    assert_eq!(body["reasoning_effort"], "medium");
    assert_eq!(
        body["max_tokens"].as_u64(),
        Some(4_000 + u64::from(Effort::Medium.room()))
    );
    Ok(())
}

#[tokio::test]
async fn off_and_max_reach_each_openai_format_in_its_own_words() -> Result {
    let fake = FakeProvider::start("ok").await?;
    let models = models(&fake)?;
    models
        .chat("chat/kimi", &Prompt::ask("hi").effort(Effort::Off))
        .await?;
    models
        .chat("resp/gpt", &Prompt::ask("hi").effort(Effort::Max))
        .await?;
    let seen = bodies(&fake);
    assert_eq!(seen[0]["reasoning_effort"], "none");
    assert_eq!(seen[1]["reasoning"]["effort"], "xhigh");
    Ok(())
}

#[tokio::test]
async fn an_anthropic_endpoint_gets_a_thinking_budget_that_fits_under_the_answer_limit() -> Result {
    let fake = FakeProvider::start("ok").await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("hi").max_tokens(4_000).effort(Effort::Medium);
    models.chat("msgs/claude-sonnet-4-5", &prompt).await?;
    let body = &bodies(&fake)[0];
    let limit = body["max_tokens"].as_u64().ok_or("no max_tokens")?;
    assert!(
        body.get("thinking").is_some() || body["output_config"].get("effort").is_some(),
        "no reasoning setting in {body}"
    );
    if let Some(budget) = body["thinking"]["budget_tokens"].as_u64() {
        assert!(budget < limit, "budget {budget} is not under {limit}");
        assert!(limit - budget >= 4_000, "the answer lost its room: {body}");
    }
    Ok(())
}

#[tokio::test]
async fn the_provider_default_sends_no_reasoning_setting_and_keeps_the_limit() -> Result {
    let fake = FakeProvider::start("ok").await?;
    let models = models(&fake)?;
    models
        .chat("chat/kimi", &Prompt::ask("hi").max_tokens(500))
        .await?;
    let body = &bodies(&fake)[0];
    assert!(body.get("reasoning_effort").is_none());
    assert_eq!(body["max_tokens"].as_u64(), Some(500));
    Ok(())
}

#[tokio::test]
async fn an_endpoint_that_refuses_the_effort_still_answers_and_is_not_sent_it_again() -> Result {
    let fake =
        FakeProvider::start_sequence(vec![Script::failing(400), Script::reply("fine")]).await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("hi").effort(Effort::High);
    let reply = models.chat("chat/kimi", &prompt).await?;
    assert_eq!(reply.text, "fine");
    assert_eq!(streamed(&models, "chat/kimi", &prompt).await?, "fine");
    let seen = bodies(&fake);
    assert_eq!(seen.len(), 3, "one refusal, then one call each");
    assert_eq!(seen[0]["reasoning_effort"], "high");
    assert!(seen[1].get("reasoning_effort").is_none());
    assert!(seen[2].get("reasoning_effort").is_none());
    Ok(())
}

#[tokio::test]
async fn a_streamed_turn_refused_over_its_effort_still_streams_an_answer() -> Result {
    let fake =
        FakeProvider::start_sequence(vec![Script::failing(422), Script::reply("streamed")]).await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("hi").effort(Effort::Low);
    assert_eq!(streamed(&models, "chat/kimi", &prompt).await?, "streamed");
    let seen = bodies(&fake);
    assert_eq!(seen[0]["reasoning_effort"], "low");
    assert!(seen[1].get("reasoning_effort").is_none());
    Ok(())
}

#[tokio::test]
async fn a_request_refused_with_no_effort_sent_is_not_sent_again() -> Result {
    let fake = FakeProvider::start_with(Script::failing(400)).await?;
    let models = models(&fake)?;
    let failed = models.chat("chat/kimi", &Prompt::ask("hi")).await;
    assert_eq!(failed.err().and_then(|e| e.status()), Some(400));
    assert_eq!(fake.seen().len(), 1);
    Ok(())
}

#[tokio::test]
async fn a_request_refused_for_another_reason_fails_and_keeps_the_effort_for_next_time() -> Result {
    let fake = FakeProvider::start_sequence(vec![
        Script::failing(400),
        Script::failing(400),
        Script::reply("ok"),
    ])
    .await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("hi").effort(Effort::Medium);
    assert!(models.chat("chat/kimi", &prompt).await.is_err());
    models.chat("chat/kimi", &prompt).await?;
    let seen = bodies(&fake);
    assert_eq!(seen.len(), 3);
    assert_eq!(seen[2]["reasoning_effort"], "medium");
    Ok(())
}

#[tokio::test]
async fn a_refusal_over_the_thinkings_room_keeps_the_effort_within_the_answer_limit() -> Result {
    let fake =
        FakeProvider::start_sequence(vec![Script::failing(400), Script::reply("fine")]).await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("hi").max_tokens(4_000).effort(Effort::Medium);
    models.chat("chat/kimi", &prompt).await?;
    models.chat("chat/kimi", &prompt).await?;
    let seen = bodies(&fake);
    assert_eq!(seen.len(), 3, "one refusal, then one call each");
    assert!(seen[0]["max_tokens"].as_u64() > Some(4_000));
    for body in &seen[1..] {
        assert_eq!(body["reasoning_effort"], "medium", "{body}");
        assert_eq!(body["max_tokens"].as_u64(), Some(4_000), "{body}");
    }
    Ok(())
}

#[tokio::test]
async fn a_try_without_the_effort_that_fails_otherwise_answers_with_the_first_refusal() -> Result {
    let fake =
        FakeProvider::start_sequence(vec![Script::failing(400), Script::failing(429)]).await?;
    let models = models(&fake)?;
    let failed = models
        .chat("chat/kimi", &Prompt::ask("hi").effort(Effort::High))
        .await;
    assert_eq!(failed.err().and_then(|e| e.status()), Some(400));
    assert_eq!(fake.seen().len(), 2);
    Ok(())
}

#[tokio::test]
async fn a_refused_effort_word_never_holds_back_another_on_the_same_model() -> Result {
    let fake =
        FakeProvider::start_sequence(vec![Script::failing(400), Script::reply("fine")]).await?;
    let models = models(&fake)?;
    models
        .chat("chat/kimi", &Prompt::ask("hi").effort(Effort::Off))
        .await?;
    models
        .chat("chat/kimi", &Prompt::ask("hi").effort(Effort::Medium))
        .await?;
    let seen = bodies(&fake);
    assert!(seen[1].get("reasoning_effort").is_none());
    assert_eq!(seen[2]["reasoning_effort"], "medium");
    Ok(())
}

#[tokio::test]
async fn an_endpoint_pointed_somewhere_else_is_sent_the_effort_again() -> Result {
    let first =
        FakeProvider::start_sequence(vec![Script::failing(400), Script::reply("fine")]).await?;
    let second = FakeProvider::start("fine").await?;
    let models = models(&first)?;
    let prompt = Prompt::ask("hi").effort(Effort::High);
    models.chat("chat/kimi", &prompt).await?;
    let mut endpoints = models.endpoints().as_ref().clone();
    for endpoint in &mut endpoints {
        if endpoint.id == "chat" {
            endpoint.base_url.clone_from(&second.root);
        }
    }
    models.set_endpoints(endpoints);
    models.chat("chat/kimi", &prompt).await?;
    assert_eq!(bodies(&second)[0]["reasoning_effort"], "high");
    Ok(())
}

#[tokio::test]
async fn a_model_id_that_names_its_effort_keeps_it_over_the_roles() -> Result {
    let fake = FakeProvider::start("ok").await?;
    let models = models(&fake)?;
    models
        .chat("chat/o3-high", &Prompt::ask("hi").effort(Effort::Low))
        .await?;
    let body = &bodies(&fake)[0];
    assert_eq!(body["model"], "o3");
    assert_eq!(body["reasoning_effort"], "high");
    Ok(())
}
