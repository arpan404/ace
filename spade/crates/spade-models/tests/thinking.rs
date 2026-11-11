//! A model's thinking is kept whole and sent back exactly, through the real SDK and HTTP: signed
//! and redacted Anthropic thinking around a tool call, and OpenAI-style `reasoning_content`.

use futures_util::StreamExt;
use serde_json::{Value, json};
use spade_models::{Catalog, Delta, Keys, Models, Prompt, Thought, ToolCall, ToolSpec};
use spade_testkit::{FakeProvider, Script};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn models(fake: &FakeProvider) -> Result<Models> {
    let json = json!({
        "roles": { "main": "msgs/opus", "fast": "msgs/opus", "deep": "msgs/opus" },
        "endpoints": [
            { "id": "msgs", "name": "Messages", "format": "anthropic", "base_url": fake.root,
              "key": { "env": "K" }, "models": [ { "id": "opus", "name": "Opus" } ] },
            { "id": "chat", "name": "Chat", "format": "openai-chat", "base_url": fake.root,
              "key": { "env": "K" }, "models": [ { "id": "kimi", "name": "Kimi" } ] }
        ]
    });
    Ok(Models::new(
        Catalog::from_json(&json.to_string())?,
        Keys::new(|_| Some("key".to_owned())),
        "test",
    )?)
}

fn lookup() -> ToolSpec {
    ToolSpec {
        name: "lookup".into(),
        description: "Look something up".into(),
        schema: json!({ "type": "object" }),
    }
}

fn thinking_script() -> Script {
    Script::reply("")
        .thinking("The person wants the weather; look it up.", "sig-1")
        .redacted("opaque-bytes")
        .call("t1", "lookup", json!({ "city": "Oxford" }))
}

/// Streams one reply and returns its calls and thoughts.
async fn stream(
    models: &Models,
    reference: &str,
    prompt: &Prompt,
) -> Result<(Vec<ToolCall>, Vec<Thought>)> {
    let mut stream = Box::pin(models.stream(reference, prompt).await?);
    let mut calls = Vec::new();
    while let Some(delta) = stream.next().await {
        match delta? {
            Delta::Call(call) => calls.push(call),
            Delta::Done { thoughts, .. } => return Ok((calls, thoughts)),
            _ => {}
        }
    }
    Err("the stream ended without Done".into())
}

fn follow_up(calls: &[ToolCall], thoughts: Vec<Thought>) -> Prompt {
    let mut prompt = Prompt::ask("Weather in Oxford?")
        .tools(vec![lookup()])
        .spade_calls("", calls.to_vec(), thoughts);
    if let Some(call) = calls.first() {
        prompt = prompt.tool_result(call, "12C", false);
    }
    prompt
}

/// The assistant message of the follow-up request, as sent.
fn assistant(fake: &FakeProvider) -> Value {
    fake.seen()
        .last()
        .and_then(|s| {
            s.body["messages"]
                .as_array()
                .and_then(|m| m.iter().find(|m| m["role"] == "assistant").cloned())
        })
        .unwrap_or(Value::Null)
}

fn expected_anthropic_content() -> Value {
    json!([
        { "type": "thinking", "thinking": "The person wants the weather; look it up.", "signature": "sig-1" },
        { "type": "redacted_thinking", "data": "opaque-bytes" },
        { "type": "tool_use", "id": "t1", "name": "lookup", "input": { "city": "Oxford" } }
    ])
}

#[tokio::test]
async fn streamed_anthropic_thinking_goes_back_whole_and_in_order_with_the_tool_call() -> Result {
    let fake = FakeProvider::start_sequence(vec![thinking_script(), Script::reply("12C.")]).await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("Weather in Oxford?").tools(vec![lookup()]);
    let (calls, thoughts) = stream(&models, "msgs/opus", &prompt).await?;
    assert_eq!(
        thoughts,
        vec![
            Thought::Signed {
                signature: "sig-1".into(),
                reasoning: Some("The person wants the weather; look it up.".into())
            },
            Thought::Block {
                data: json!({ "type": "redacted_thinking", "data": "opaque-bytes" })
            }
        ]
    );
    stream(&models, "msgs/opus", &follow_up(&calls, thoughts)).await?;
    assert_eq!(assistant(&fake)["content"], expected_anthropic_content());
    Ok(())
}

#[tokio::test]
async fn plain_anthropic_thinking_goes_back_whole_and_in_order_with_the_tool_call() -> Result {
    let fake = FakeProvider::start_sequence(vec![thinking_script(), Script::reply("12C.")]).await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("Weather in Oxford?").tools(vec![lookup()]);
    let reply = models.chat("msgs/opus", &prompt).await?;
    models
        .chat("msgs/opus", &follow_up(&reply.calls, reply.thoughts))
        .await?;
    assert_eq!(assistant(&fake)["content"], expected_anthropic_content());
    Ok(())
}

#[tokio::test]
async fn openai_style_reasoning_content_goes_back_with_the_tool_call() -> Result {
    let script = Script::reply("")
        .thinking("Need the weather tool.", "unused")
        .call("t1", "lookup", json!({ "city": "Oxford" }));
    let fake = FakeProvider::start_sequence(vec![script, Script::reply("12C.")]).await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("Weather in Oxford?").tools(vec![lookup()]);
    let (calls, thoughts) = stream(&models, "chat/kimi", &prompt).await?;
    assert_eq!(
        thoughts,
        vec![Thought::Reasoning {
            text: "Need the weather tool.".into()
        }]
    );
    stream(&models, "chat/kimi", &follow_up(&calls, thoughts)).await?;
    let sent = assistant(&fake);
    assert_eq!(
        sent["reasoning_content"], "Need the weather tool.",
        "{sent}"
    );
    assert_eq!(sent["tool_calls"][0]["id"], "t1");
    Ok(())
}
