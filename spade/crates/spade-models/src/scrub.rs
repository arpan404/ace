//! A signed-in account's answer with the call's own tokens taken out (ADR 0214): whatever the
//! backend sends back, the bearer a call sent never reaches a subscriber, a checkpoint or a typed
//! value. Text and reasoning arrive in pieces, so the tail of each piece that could be the start
//! of a token is held back until the next shows whether it is.

use std::collections::VecDeque;

use futures_util::{Stream, StreamExt};
use serde_json::Value;

use crate::error::ModelError;
use crate::prompt::{Delta, Thought, ToolCall};

/// What stands in for a token taken out.
const HIDDEN: &str = "[hidden]";

/// `stream` with every one of `secrets` taken out of its text, reasoning, tool arguments and
/// thoughts.
pub(crate) fn stream<S>(
    stream: S,
    secrets: Vec<String>,
) -> impl Stream<Item = Result<Delta, ModelError>> + Send
where
    S: Stream<Item = Result<Delta, ModelError>> + Send + Unpin,
{
    let state = State {
        stream,
        secrets: secrets.into_iter().filter(|s| !s.is_empty()).collect(),
        text: String::new(),
        reasoning: String::new(),
        out: VecDeque::new(),
        ended: false,
    };
    futures_util::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(next) = state.out.pop_front() {
                return Some((next, state));
            }
            if state.ended {
                return None;
            }
            match state.stream.next().await {
                Some(item) => state.take(item),
                None => {
                    state.flush();
                    state.ended = true;
                }
            }
        }
    })
}

struct State<S> {
    stream: S,
    secrets: Vec<String>,
    /// Held-back tails of text and reasoning.
    text: String,
    reasoning: String,
    out: VecDeque<Result<Delta, ModelError>>,
    ended: bool,
}

impl<S> State<S> {
    fn take(&mut self, item: Result<Delta, ModelError>) {
        match item {
            Ok(Delta::Text(piece)) => {
                // What reasoning held back is older than this text: it goes first, in order.
                self.flush_reasoning();
                let ready = pass(&mut self.text, &piece, &self.secrets);
                if !ready.is_empty() {
                    self.out.push_back(Ok(Delta::Text(ready)));
                }
            }
            Ok(Delta::Reasoning(piece)) => {
                self.flush_text();
                let ready = pass(&mut self.reasoning, &piece, &self.secrets);
                if !ready.is_empty() {
                    self.out.push_back(Ok(Delta::Reasoning(ready)));
                }
            }
            Ok(Delta::CallClosed(call)) => {
                self.flush();
                self.out.push_back(Ok(Delta::CallClosed(ToolCall {
                    arguments: hidden_value(call.arguments, &self.secrets),
                    ..call
                })));
            }
            Ok(Delta::Call(call)) => {
                self.flush();
                self.out.push_back(Ok(Delta::Call(ToolCall {
                    arguments: hidden_value(call.arguments, &self.secrets),
                    ..call
                })));
            }
            Ok(Delta::Done { usage, thoughts }) => {
                self.flush();
                let thoughts = thoughts
                    .into_iter()
                    .map(|t| hidden_thought(t, &self.secrets))
                    .collect();
                self.out.push_back(Ok(Delta::Done { usage, thoughts }));
            }
            Err(error) => {
                self.flush();
                self.out.push_back(Err(error));
            }
        }
    }

    /// Sends what was held back: nothing more is coming that could complete a token. Only one
    /// kind ever holds anything (a new kind flushes the other first), so the order is kept.
    fn flush(&mut self) {
        self.flush_text();
        self.flush_reasoning();
    }

    fn flush_text(&mut self) {
        let text = std::mem::take(&mut self.text);
        if !text.is_empty() {
            self.out.push_back(Ok(Delta::Text(text)));
        }
    }

    fn flush_reasoning(&mut self) {
        let reasoning = std::mem::take(&mut self.reasoning);
        if !reasoning.is_empty() {
            self.out.push_back(Ok(Delta::Reasoning(reasoning)));
        }
    }
}

/// `held` and `piece` together, every secret taken out; what can go now is returned, and the tail
/// that could still be the start of a secret is kept in `held`.
fn pass(held: &mut String, piece: &str, secrets: &[String]) -> String {
    let mut all = std::mem::take(held);
    all.push_str(piece);
    let all = hidden(&all, secrets);
    let keep = secrets
        .iter()
        .flat_map(|secret| {
            (1..secret.len())
                .filter(move |&k| secret.is_char_boundary(k))
                .map(move |k| &secret[..k])
        })
        .filter(|start| all.ends_with(start))
        .map(str::len)
        .max()
        .unwrap_or(0);
    let cut = all.len() - keep;
    *held = all[cut..].to_owned();
    all[..cut].to_owned()
}

fn hidden(text: &str, secrets: &[String]) -> String {
    secrets.iter().fold(text.to_owned(), |text, secret| {
        text.replace(secret.as_str(), HIDDEN)
    })
}

/// A typed answer's text with every secret taken out of its decoded strings too: JSON may spell
/// a token with escapes (`\u0061`, `\/`) that only decode when it is parsed.
pub(crate) fn decoded_text(text: &str, secrets: &[String]) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => hidden_value(value, secrets).to_string(),
        Err(_) => hidden(text, secrets),
    }
}

fn hidden_value(value: Value, secrets: &[String]) -> Value {
    match value {
        // A string that is itself JSON (arguments a tool parses later) is cleaned decoded, so an
        // escaped token can't come back out of it.
        Value::String(text) => match serde_json::from_str::<Value>(&text) {
            Ok(inner @ (Value::Object(_) | Value::Array(_) | Value::String(_))) => {
                let cleaned = hidden_value(inner.clone(), secrets);
                if cleaned == inner {
                    Value::String(hidden(&text, secrets))
                } else {
                    Value::String(cleaned.to_string())
                }
            }
            _ => Value::String(hidden(&text, secrets)),
        },
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|v| hidden_value(v, secrets))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (hidden(&k, secrets), hidden_value(v, secrets)))
                .collect(),
        ),
        other => other,
    }
}

fn hidden_thought(thought: Thought, secrets: &[String]) -> Thought {
    match thought {
        Thought::Signed {
            signature,
            reasoning,
        } => Thought::Signed {
            signature,
            reasoning: reasoning.map(|r| hidden(&r, secrets)),
        },
        Thought::Reasoning { text } => Thought::Reasoning {
            text: hidden(&text, secrets),
        },
        Thought::Block { data } => Thought::Block {
            data: hidden_value(data, secrets),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(t: &str) -> Result<Delta, ModelError> {
        Ok(Delta::Text(t.to_owned()))
    }

    fn reasoning(t: &str) -> Result<Delta, ModelError> {
        Ok(Delta::Reasoning(t.to_owned()))
    }

    #[tokio::test]
    async fn text_and_reasoning_leave_in_the_order_they_came_with_a_split_secret_taken_out() {
        let secrets = vec!["tok-123456".to_owned()];
        let came = futures_util::stream::iter(vec![
            text("a tok-12"),
            text("3456 b tok-"),
            reasoning("thinking"),
            text("rest"),
        ]);
        let out: Vec<(bool, String)> = stream(came, secrets)
            .map(|d| match d {
                Ok(Delta::Text(t)) => (true, t),
                Ok(Delta::Reasoning(t)) => (false, t),
                other => (false, format!("{other:?}")),
            })
            .collect()
            .await;
        let wanted: Vec<(bool, String)> = [
            (true, "a "),
            (true, "[hidden] b "),
            (true, "tok-"),
            (false, "thinking"),
            (true, "res"),
            (true, "t"),
        ]
        .into_iter()
        .map(|(kind, t)| (kind, t.to_owned()))
        .collect();
        assert_eq!(out, wanted);
    }

    #[test]
    fn an_escaped_secret_in_json_held_in_a_string_or_a_typed_answer_is_taken_out() {
        let secrets = vec!["access-1".to_owned()];
        let nested = Value::String(r#"{"said":"\u0061ccess-1","path":"access\/x"}"#.to_owned());
        let cleaned = hidden_value(serde_json::json!({ "payload": nested }), &secrets);
        let decoded: Value = serde_json::from_str(cleaned["payload"].as_str().unwrap_or_default())
            .unwrap_or_default();
        assert_eq!(decoded["said"], "[hidden]");
        let typed = decoded_text(r#"{"said":"the token is \u0061ccess-1"}"#, &secrets);
        let value: Value = serde_json::from_str(&typed).unwrap_or_default();
        assert_eq!(value["said"], "the token is [hidden]");
    }

    #[test]
    fn a_secret_split_across_pieces_never_gets_out_and_the_rest_does() {
        let secrets = vec!["tok-123456".to_owned()];
        let mut held = String::new();
        let mut out = String::new();
        for piece in ["a tok-", "12", "3456 b, tok-9 c", " tok-"] {
            out.push_str(&pass(&mut held, piece, &secrets));
        }
        out.push_str(&held);
        assert_eq!(out, "a [hidden] b, tok-9 c tok-");
    }
}
