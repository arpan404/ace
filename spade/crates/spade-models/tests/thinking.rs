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
    follow_on("Weather in Oxford?", calls, thoughts)
}

/// The follow-up to a first reply, from a conversation that starts with `start`.
fn follow_on(start: &str, calls: &[ToolCall], thoughts: Vec<Thought>) -> Prompt {
    let mut prompt =
        Prompt::ask(start)
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

/// The thinking blocks of the last request's assistant message, as sent.
fn thinking_blocks(fake: &FakeProvider) -> Vec<Value> {
    assistant(fake)["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "thinking" || block["type"] == "redacted_thinking")
        .cloned()
        .collect()
}

#[tokio::test]
async fn streamed_anthropic_thinking_goes_back_whole_and_in_order_with_the_tool_call() -> Result {
    let fake = FakeProvider::start_sequence(vec![thinking_script(), Script::reply("12C.")]).await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("Weather in Oxford?").tools(vec![lookup()]);
    let (calls, thoughts) = stream(&models, "msgs/opus", &prompt).await?;
    assert_eq!(thoughts.len(), 2, "{thoughts:?}");
    match &thoughts[0] {
        Thought::Signed {
            signature,
            reasoning,
            bound,
        } => {
            assert_eq!(signature, "sig-1");
            assert_eq!(
                reasoning.as_deref(),
                Some("The person wants the weather; look it up.")
            );
            assert!(bound.is_some(), "a fresh thought is bound: {thoughts:?}");
        }
        other => panic!("expected signed thinking, got {other:?}"),
    }
    assert!(
        matches!(&thoughts[1], Thought::Block { data, bound: Some(_) }
            if *data == json!({ "type": "redacted_thinking", "data": "opaque-bytes" })),
        "{thoughts:?}"
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
    assert_eq!(thoughts.len(), 1, "{thoughts:?}");
    match &thoughts[0] {
        Thought::Reasoning { text, bound } => {
            assert_eq!(text, "Need the weather tool.");
            assert!(bound.is_some(), "a fresh thought is bound: {thoughts:?}");
        }
        other => panic!("expected reasoning, got {other:?}"),
    }
    stream(&models, "chat/kimi", &follow_up(&calls, thoughts)).await?;
    let sent = assistant(&fake);
    assert_eq!(
        sent["reasoning_content"], "Need the weather tool.",
        "{sent}"
    );
    assert_eq!(sent["tool_calls"][0]["id"], "t1");
    Ok(())
}

#[tokio::test]
async fn thinking_made_before_the_conversations_start_changed_is_not_sent_back() -> Result {
    let fake = FakeProvider::start_sequence(vec![thinking_script(), Script::reply("12C.")]).await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("Weather in Oxford?").tools(vec![lookup()]);
    let (calls, thoughts) = stream(&models, "msgs/opus", &prompt).await?;
    // Compaction rewrote what came before the reply: a summary now starts the conversation.
    let follow = follow_on("<summary>\nearlier talk\n</summary>", &calls, thoughts);
    stream(&models, "msgs/opus", &follow).await?;
    assert_eq!(
        assistant(&fake)["content"],
        json!([{ "type": "tool_use", "id": "t1", "name": "lookup", "input": { "city": "Oxford" } }])
    );
    assert!(thinking_blocks(&fake).is_empty(), "{}", assistant(&fake));
    Ok(())
}

#[tokio::test]
async fn thinking_is_not_sent_back_after_the_tools_offered_changed() -> Result {
    let fake = FakeProvider::start_sequence(vec![thinking_script(), Script::reply("12C.")]).await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("Weather in Oxford?").tools(vec![lookup()]);
    let (calls, thoughts) = stream(&models, "msgs/opus", &prompt).await?;
    // The same messages, but `lookup` now takes a city: the signature no longer matches.
    let mut changed = lookup();
    changed.schema = json!({ "type": "object", "properties": { "city": { "type": "string" } } });
    let follow = follow_up(&calls, thoughts).tools(vec![changed]);
    stream(&models, "msgs/opus", &follow).await?;
    assert_eq!(
        assistant(&fake)["content"],
        json!([{ "type": "tool_use", "id": "t1", "name": "lookup", "input": { "city": "Oxford" } }])
    );
    assert!(thinking_blocks(&fake).is_empty(), "{}", assistant(&fake));
    Ok(())
}

#[tokio::test]
async fn thinking_stored_by_an_older_build_is_not_sent_back_to_anthropic() -> Result {
    let fake = FakeProvider::start_sequence(vec![thinking_script(), Script::reply("12C.")]).await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("Weather in Oxford?").tools(vec![lookup()]);
    let (calls, _) = stream(&models, "msgs/opus", &prompt).await?;
    // A conversation stored before thoughts carried the prefix they were made from.
    let old: Vec<Thought> = serde_json::from_value(json!([
        { "kind": "signed", "signature": "sig-1",
          "reasoning": "The person wants the weather; look it up." },
        { "kind": "block", "data": { "type": "redacted_thinking", "data": "opaque-bytes" } }
    ]))?;
    assert_eq!(old.len(), 2, "the old shape still reads");
    stream(&models, "msgs/opus", &follow_up(&calls, old)).await?;
    assert_eq!(
        assistant(&fake)["content"],
        json!([{ "type": "tool_use", "id": "t1", "name": "lookup", "input": { "city": "Oxford" } }])
    );
    assert!(thinking_blocks(&fake).is_empty(), "{}", assistant(&fake));
    Ok(())
}

#[tokio::test]
async fn another_format_still_sends_its_reasoning_back_after_the_start_changed() -> Result {
    let script = Script::reply("")
        .thinking("Need the weather tool.", "unused")
        .call("t1", "lookup", json!({ "city": "Oxford" }));
    let fake = FakeProvider::start_sequence(vec![script, Script::reply("12C.")]).await?;
    let models = models(&fake)?;
    let prompt = Prompt::ask("Weather in Oxford?").tools(vec![lookup()]);
    let (calls, thoughts) = stream(&models, "chat/kimi", &prompt).await?;
    let follow = follow_on("<summary>\nearlier talk\n</summary>", &calls, thoughts);
    stream(&models, "chat/kimi", &follow).await?;
    let sent = assistant(&fake);
    assert_eq!(
        sent["reasoning_content"], "Need the weather tool.",
        "{sent}"
    );
    assert_eq!(sent["tool_calls"][0]["id"], "t1");
    Ok(())
}
