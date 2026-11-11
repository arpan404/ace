//! What every request says about itself: the session header that routes a conversation's calls
//! together, and Spade's User-Agent.

use futures_util::StreamExt;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use spade_models::{Catalog, Keys, Models, Prompt};
use spade_testkit::{FakeProvider, Seen};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// `routed` (OpenAI Chat) and `routed-msgs` (Anthropic) name a session header; `plain` does not.
fn models(fake: &FakeProvider) -> Result<Models> {
    let root = &fake.root;
    let json = json!({
        "roles": { "main": "routed/m", "fast": "routed-msgs/m", "deep": "plain/m" },
        "endpoints": [
            { "id": "routed", "name": "Routed", "format": "openai-chat", "base_url": root,
              "key": { "env": "KEY" }, "session_header": "x-opencode-session",
              "models": [ { "id": "m", "name": "M" } ] },
            { "id": "routed-msgs", "name": "Routed messages", "format": "anthropic",
              "base_url": root, "key": { "env": "KEY" }, "session_header": "x-opencode-session",
              "models": [ { "id": "m", "name": "M" } ] },
            { "id": "plain", "name": "Plain", "format": "openai-chat", "base_url": root,
              "key": { "env": "KEY" }, "models": [ { "id": "m", "name": "M" } ] }
        ]
    });
    Ok(Models::new(
        Catalog::from_json(&json.to_string())?,
        Keys::new(|_| Some("key".to_owned())),
        "1.2.3",
    )?)
}

fn header(seen: &Seen, name: &str) -> Option<String> {
    seen.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.clone())
}

fn sessions(fake: &FakeProvider) -> Vec<Option<String>> {
    fake.seen()
        .iter()
        .map(|seen| header(seen, "x-opencode-session"))
        .collect()
}

#[derive(Debug, Deserialize, JsonSchema)]
struct Verdict {
    relevant: bool,
}

#[tokio::test]
async fn every_call_of_a_conversation_carries_its_session_id_and_another_conversation_its_own()
-> Result {
    let fake = FakeProvider::start(r#"{"relevant":true}"#).await?;
    let models = models(&fake)?;
    let first = Prompt::ask("hi").session("conv-1");
    models.chat("routed/m", &first).await?;
    let mut stream = Box::pin(models.stream("routed/m", &first).await?);
    while stream.next().await.is_some() {}
    models.chat("routed-msgs/m", &first).await?;
    let verdict = models.generate::<Verdict>("routed/m", &first).await?;
    assert!(verdict.value.relevant);
    models
        .chat("routed/m", &Prompt::ask("hi").session("conv-2"))
        .await?;

    let one = Some("conv-1".to_owned());
    assert_eq!(
        sessions(&fake),
        vec![
            one.clone(),
            one.clone(),
            one.clone(),
            one,
            Some("conv-2".to_owned())
        ]
    );
    Ok(())
}

#[tokio::test]
async fn no_session_header_is_sent_by_an_endpoint_without_one_or_for_a_call_outside_a_conversation()
-> Result {
    let fake = FakeProvider::start("ok").await?;
    let models = models(&fake)?;
    models
        .chat("plain/m", &Prompt::ask("hi").session("conv-1"))
        .await?;
    models.chat("routed/m", &Prompt::ask("hi")).await?;

    assert_eq!(sessions(&fake), vec![None, None]);
    Ok(())
}

#[tokio::test]
async fn every_request_identifies_itself_as_spade_and_its_version() -> Result {
    let fake = FakeProvider::start("ok").await?;
    let models = models(&fake)?;
    models.chat("routed/m", &Prompt::ask("hi")).await?;
    models.chat("routed-msgs/m", &Prompt::ask("hi")).await?;
    let mut stream = Box::pin(models.stream("plain/m", &Prompt::ask("hi")).await?);
    while stream.next().await.is_some() {}

    let agents: Vec<Option<String>> = fake
        .seen()
        .iter()
        .map(|seen| header(seen, "user-agent"))
        .collect();
    assert_eq!(agents, vec![Some("spade/1.2.3".to_owned()); 3]);
    Ok(())
}
