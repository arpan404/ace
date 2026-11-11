//! Calls go through the real SDK and HTTP to a local fake endpoint, one per wire format.

use futures_util::StreamExt;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use spade_models::{
    Catalog, Delta, KEYLESS, Keys, ModelError, Models, Prompt, ToolCall, ToolSpec, Usage,
};
use spade_testkit::{FakeProvider, Script, Seen};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Endpoints of every format, all pointing at `fake`:
/// `chat` (OpenAI Chat Completions), `resp` (OpenAI Responses), `msgs` (Anthropic Messages),
/// `router` (a model id with a slash), `local` (no key) and `nokey` (key not set).
fn catalog(fake: &FakeProvider) -> Result<Catalog> {
    let root = &fake.root;
    let json = json!({
        "roles": { "main": "chat/kimi", "fast": "msgs/haiku", "deep": "resp/sol" },
        "endpoints": [
            { "id": "chat", "name": "Chat", "format": "openai-chat", "base_url": root,
              "key": { "env": "CHAT_KEY" }, "headers": { "x-team": "spade" },
              "models": [ { "id": "kimi", "name": "Kimi" } ] },
            { "id": "resp", "name": "Responses", "format": "openai-responses", "base_url": root,
              "key": { "env": "RESP_KEY" }, "models": [ { "id": "sol", "name": "Sol" } ] },
            { "id": "msgs", "name": "Messages", "format": "anthropic", "base_url": root,
              "key": { "env": "MSGS_KEY" }, "models": [ { "id": "haiku", "name": "Haiku" } ] },
            { "id": "router", "name": "Router", "format": "openai-chat", "base_url": root,
              "key": { "env": "CHAT_KEY" },
              "models": [ { "id": "anthropic/claude-sonnet-5.5", "name": "Sonnet" } ] },
            { "id": "local", "name": "Local", "format": "openai-chat", "base_url": root,
              "models": [ { "id": "llama", "name": "Llama" } ] },
            { "id": "nokey", "name": "No key", "format": "anthropic", "base_url": root,
              "key": { "env": "UNSET_KEY" }, "models": [ { "id": "x", "name": "X" } ] },
            { "id": "vault", "name": "Keychain only", "format": "openai-chat", "base_url": root,
              "key": {}, "models": [ { "id": "v", "name": "V" } ] }
        ]
    });
    Ok(Catalog::from_json(&json.to_string())?)
}

/// The keychain holds keys for `vault` and `msgs`; the environment holds the rest.
fn models(fake: &FakeProvider) -> Result<Models> {
    let keychain = |endpoint: &str| match endpoint {
        "vault" => Some("vault-key".to_owned()),
        "msgs" => Some("msgs-keychain-key".to_owned()),
        _ => None,
    };
    let env = |name: &str| match name {
        "CHAT_KEY" => Some("chat-key".to_owned()),
        "RESP_KEY" => Some("resp-key".to_owned()),
        "MSGS_KEY" => Some("msgs-env-key".to_owned()),
        _ => None,
    };
    Ok(Models::new(
        catalog(fake)?,
        Keys::keychain_then_env(keychain, env),
        "test",
    )?)
}

fn only_request(fake: &FakeProvider) -> Result<Seen> {
    let mut seen = fake.seen();
    assert_eq!(seen.len(), 1, "expected one request, got {seen:?}");
    seen.pop().ok_or_else(|| "no request".into())
}

fn usage(input: u32, read: Option<u32>, write: Option<u32>) -> Usage {
    Usage {
        input_tokens: Some(input),
        output_tokens: Some(7),
        cache_read_tokens: read,
        cache_write_tokens: write,
    }
}

#[derive(Debug, Deserialize, JsonSchema, PartialEq)]
struct Verdict {
    relevant: bool,
    score: u8,
}

#[tokio::test]
async fn an_openai_chat_endpoint_gets_its_key_model_and_headers() -> Result {
    let fake = FakeProvider::start("Hello from Kimi").await?;
    let reply = models(&fake)?.chat("chat/kimi", &Prompt::ask("hi")).await?;

    assert_eq!(
        (reply.model.as_str(), reply.text.as_str()),
        ("chat/kimi", "Hello from Kimi")
    );
    let request = only_request(&fake)?;
    assert_eq!(request.path, "/chat/completions");
    assert_eq!(request.key.as_deref(), Some("Bearer chat-key"));
    assert_eq!(request.body["model"], "kimi");
    assert!(
        request
            .headers
            .contains(&("x-team".to_owned(), "spade".to_owned()))
    );
    Ok(())
}

#[tokio::test]
async fn an_openai_responses_endpoint_is_called_at_responses() -> Result {
    let fake = FakeProvider::start("Hello from Sol").await?;
    let reply = models(&fake)?.chat("resp/sol", &Prompt::ask("hi")).await?;

    assert_eq!(reply.text, "Hello from Sol");
    // Nothing was cached, which the SDK reports as no count rather than zero.
    assert_eq!(reply.usage, usage(11, None, None));
    let request = only_request(&fake)?;
    assert_eq!(request.path, "/responses");
    assert_eq!(request.key.as_deref(), Some("Bearer resp-key"));
    assert_eq!(request.body["model"], "sol");
    Ok(())
}

#[tokio::test]
async fn an_anthropic_endpoint_gets_its_key_in_x_api_key() -> Result {
    let fake = FakeProvider::start("Hello from Haiku").await?;
    let reply = models(&fake)?
        .chat("msgs/haiku", &Prompt::ask("hi"))
        .await?;

    assert_eq!(reply.text, "Hello from Haiku");
    let request = only_request(&fake)?;
    assert_eq!(request.path, "/messages");
    // The keychain's key wins over MSGS_KEY in the environment.
    assert_eq!(request.key.as_deref(), Some("msgs-keychain-key"));
    assert_eq!(request.body["model"], "haiku");
    Ok(())
}

#[tokio::test]
async fn a_model_id_with_a_slash_is_sent_whole() -> Result {
    let fake = FakeProvider::start("ok").await?;
    models(&fake)?
        .chat("router/anthropic/claude-sonnet-5.5", &Prompt::ask("hi"))
        .await?;
    assert_eq!(
        only_request(&fake)?.body["model"],
        "anthropic/claude-sonnet-5.5"
    );
    Ok(())
}

#[tokio::test]
async fn a_local_endpoint_without_a_key_gets_only_the_placeholder() -> Result {
    let fake = FakeProvider::start("ok").await?;
    let reply = models(&fake)?
        .chat("local/llama", &Prompt::ask("hi"))
        .await?;
    assert_eq!(reply.text, "ok");
    let request = only_request(&fake)?;
    assert_eq!(request.key, Some(format!("Bearer {KEYLESS}")));
    Ok(())
}

#[tokio::test]
async fn a_missing_key_names_the_variable_and_never_calls_the_endpoint() -> Result {
    let fake = FakeProvider::start("unused").await?;
    let reply = models(&fake)?.chat("nokey/x", &Prompt::ask("hi")).await;
    assert_eq!(
        reply,
        Err(ModelError::MissingKey {
            endpoint: "nokey".to_owned(),
            var: Some("UNSET_KEY".to_owned())
        })
    );
    assert!(fake.seen().is_empty());
    Ok(())
}

#[tokio::test]
async fn a_keychain_only_endpoint_uses_its_keychain_key() -> Result {
    let fake = FakeProvider::start("ok").await?;
    models(&fake)?.chat("vault/v", &Prompt::ask("hi")).await?;
    assert_eq!(
        only_request(&fake)?.key.as_deref(),
        Some("Bearer vault-key")
    );
    Ok(())
}

#[tokio::test]
async fn a_model_outside_the_catalogue_never_reaches_the_network() -> Result {
    let fake = FakeProvider::start("unused").await?;
    let reply = models(&fake)?
        .chat("chat/gpt-5.4", &Prompt::ask("hi"))
        .await;
    assert_eq!(
        reply,
        Err(ModelError::UnknownModel("chat/gpt-5.4".to_owned()))
    );
    assert!(fake.seen().is_empty());
    Ok(())
}

#[tokio::test]
async fn instructions_and_history_are_sent_in_order() -> Result {
    let fake = FakeProvider::start("ok").await?;
    let prompt = Prompt::ask("first")
        .system("Be brief.")
        .spade("noted")
        .person("second");
    models(&fake)?.chat("chat/kimi", &prompt).await?;

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
async fn typed_output_works_in_every_format() -> Result {
    let fake = FakeProvider::start_with(Script::reply(r#"{"relevant": true, "score": 7}"#)).await?;
    let models = models(&fake)?;
    for reference in ["chat/kimi", "resp/sol", "msgs/haiku"] {
        let generated = models
            .generate::<Verdict>(reference, &Prompt::ask("Relevant?"))
            .await?;
        assert!(
            generated.usage.output_tokens.is_some(),
            "{reference} reports usage"
        );
        assert_eq!(
            generated.value,
            Verdict {
                relevant: true,
                score: 7
            },
            "{reference}"
        );
    }
    let chat = fake
        .seen()
        .into_iter()
        .find(|s| s.path == "/chat/completions");
    assert_eq!(
        chat.map(|s| s.body["response_format"]["json_schema"]["name"].clone()),
        Some(json!("Verdict"))
    );
    Ok(())
}

#[tokio::test]
async fn typed_output_that_does_not_match_is_an_error() -> Result {
    let fake = FakeProvider::start(r#"{"relevant": "maybe"}"#).await?;
    let verdict = models(&fake)?
        .generate::<Verdict>("chat/kimi", &Prompt::ask("Relevant?"))
        .await;
    assert!(
        matches!(&verdict, Err(ModelError::Shape { model, .. }) if model == "chat/kimi"),
        "{verdict:?}"
    );
    Ok(())
}

#[tokio::test]
async fn every_format_streams_in_pieces_and_ends_with_usage() -> Result {
    let fake = FakeProvider::start_with(Script::reply("Streaming works fine").chunks(3)).await?;
    let models = models(&fake)?;
    for reference in ["chat/kimi", "resp/sol", "msgs/haiku"] {
        let stream = models.stream(reference, &Prompt::ask("hi")).await?;
        let deltas: Vec<Delta> = stream
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect::<std::result::Result<_, _>>()?;
        let text: String = deltas
            .iter()
            .filter_map(|d| match d {
                Delta::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Streaming works fine", "{reference}");
        assert!(
            deltas
                .iter()
                .filter(|d| matches!(d, Delta::Text(_)))
                .count()
                >= 2,
            "{reference}"
        );
        assert!(
            matches!(deltas.last(), Some(Delta::Done { usage, .. }) if usage.output_tokens == Some(7)),
            "{reference}: {:?}",
            deltas.last()
        );
    }
    Ok(())
}

#[tokio::test]
async fn cached_input_is_reported_apart_from_the_rest() -> Result {
    let fake = FakeProvider::start_with(Script::reply("ok").cached(30, 5)).await?;
    let models = models(&fake)?;
    // Anthropic reports 11 uncached, 30 read and 5 written: 46 input in all.
    let anthropic = models.chat("msgs/haiku", &Prompt::ask("hi")).await?;
    assert_eq!(anthropic.usage, usage(46, Some(30), Some(5)));
    // OpenAI counts the 30 cached tokens inside its 41 prompt tokens.
    let openai = models.chat("chat/kimi", &Prompt::ask("hi")).await?;
    assert_eq!(openai.usage.input_tokens, Some(41));
    assert_eq!(openai.usage.cache_read_tokens, Some(30));
    Ok(())
}

fn weather_tool() -> ToolSpec {
    ToolSpec {
        name: "get_weather".to_owned(),
        description: "Current weather for a city".to_owned(),
        schema: json!({ "type": "object", "properties": { "city": { "type": "string" } },
                        "required": ["city"] }),
    }
}

#[tokio::test]
async fn tools_are_offered_and_a_call_comes_back_in_every_format() -> Result {
    let fake = FakeProvider::start_with(Script::reply("Checking.").call(
        "call_1",
        "get_weather",
        json!({ "city": "Oxford" }),
    ))
    .await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("Weather in Oxford?").tools(vec![weather_tool()]);
    for reference in ["chat/kimi", "resp/sol", "msgs/haiku"] {
        let reply = models.chat(reference, &prompt).await?;
        assert_eq!(
            reply.calls,
            vec![ToolCall {
                id: "call_1".to_owned(),
                name: "get_weather".to_owned(),
                arguments: json!({ "city": "Oxford" })
            }],
            "{reference}"
        );
    }
    let chat = fake
        .seen()
        .into_iter()
        .find(|s| s.path == "/chat/completions");
    let offered = chat.map(|s| s.body["tools"][0]["function"]["name"].clone());
    assert_eq!(offered, Some(json!("get_weather")));
    Ok(())
}

#[tokio::test]
async fn a_streamed_tool_call_arrives_whole_before_done_in_every_format() -> Result {
    let fake = FakeProvider::start_with(Script::reply("Let me check").chunks(3).call(
        "call_7",
        "get_weather",
        json!({ "city": "Kathmandu", "units": "metric" }),
    ))
    .await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("Weather?").tools(vec![weather_tool()]);
    for reference in ["chat/kimi", "resp/sol", "msgs/haiku"] {
        let stream = models.stream(reference, &prompt).await?;
        let deltas: Vec<Delta> = stream
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect::<std::result::Result<_, _>>()?;
        let calls: Vec<&ToolCall> = deltas
            .iter()
            .filter_map(|d| match d {
                Delta::Call(call) => Some(call),
                _ => None,
            })
            .collect();
        assert_eq!(calls.len(), 1, "{reference}: {deltas:?}");
        assert_eq!(calls[0].id, "call_7", "{reference}");
        assert_eq!(
            calls[0].arguments,
            json!({ "city": "Kathmandu", "units": "metric" }),
            "{reference}"
        );
        assert!(
            matches!(deltas.last(), Some(Delta::Done { .. })),
            "{reference}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_tool_result_goes_back_answering_its_call() -> Result {
    let fake = FakeProvider::start("It is 12 degrees.").await?;
    let call = ToolCall {
        id: "call_1".to_owned(),
        name: "get_weather".to_owned(),
        arguments: json!({ "city": "Oxford" }),
    };
    let prompt = Prompt::ask("Weather in Oxford?")
        .tools(vec![weather_tool()])
        .spade_calls("Checking.", vec![call.clone()], Vec::new())
        .tool_result(&call, "12C, cloudy", false);
    let models = models(&fake)?;
    let reply = models.chat("chat/kimi", &prompt).await?;
    assert_eq!(reply.text, "It is 12 degrees.");
    models.chat("msgs/haiku", &prompt).await?;

    let seen = fake.seen();
    let openai = &seen[0].body["messages"];
    let assistant = openai
        .as_array()
        .and_then(|m| m.iter().find(|m| m["role"] == "assistant"));
    assert_eq!(
        assistant.map(|m| m["tool_calls"][0]["id"].clone()),
        Some(json!("call_1"))
    );
    let tool = openai
        .as_array()
        .and_then(|m| m.iter().find(|m| m["role"] == "tool"));
    assert_eq!(
        tool.map(|m| (m["tool_call_id"].clone(), m["content"].clone())),
        Some((json!("call_1"), json!("12C, cloudy")))
    );
    let anthropic = seen[1].body["messages"].to_string();
    assert!(
        anthropic.contains("\"tool_use_id\":\"call_1\""),
        "{anthropic}"
    );
    Ok(())
}
