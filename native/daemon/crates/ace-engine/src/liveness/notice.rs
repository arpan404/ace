// SPDX-License-Identifier: Apache-2.0
//! `thread-liveness.ts`'s interruption notice (E5.10): one transcript notice per interruption,
//! so a second one is never folded into the first.

use ace_json::Value;

/// What ended the turn: a daemon restart, or a provider that died on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interruption {
    Restart,
    Exit,
}

/// `interruptedNotice`: the notice an interrupted turn leaves, keyed by its time so a second
/// interruption is its own item.
pub fn interrupted_notice(
    agent: Option<&str>,
    at: f64,
    cause: Interruption,
    text: Option<&str>,
) -> Value {
    let (code, fallback) = match cause {
        Interruption::Restart => ("restart_interrupted", "Interrupted by a restart"),
        Interruption::Exit => ("agent_stopped", "The agent stopped unexpectedly"),
    };
    let at_text = ace_json::to_string(&Value::from(at));
    let mut draft = ace_json::Map::new();
    draft.insert("type", Value::from("notice"));
    draft.insert("level", Value::from("warning"));
    draft.insert("code", Value::from(code));
    draft.insert("text", Value::from(text.unwrap_or(fallback)));
    draft.insert("complete", Value::Bool(true));
    let mut fact = ace_json::Map::new();
    fact.insert("type", Value::from("item.upsert"));
    fact.insert("agent", Value::from(agent.unwrap_or("root")));
    fact.insert(
        "item",
        Value::from(format!("liveness:stopped:{at_text}").as_str()),
    );
    fact.insert("draft", Value::Object(draft));
    Value::Object(fact)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_restart_and_an_exit_read_differently_and_keep_the_agents_own_words() {
        let restart = interrupted_notice(None, 1_000.0, Interruption::Restart, None);
        assert_eq!(
            restart.get("item").and_then(Value::as_str),
            Some("liveness:stopped:1000")
        );
        assert_eq!(restart.get("agent").and_then(Value::as_str), Some("root"));
        let draft = restart.get("draft").expect("draft");
        assert_eq!(
            draft.get("code").and_then(Value::as_str),
            Some("restart_interrupted")
        );
        assert_eq!(
            draft.get("text").and_then(Value::as_str),
            Some("Interrupted by a restart")
        );
        assert_eq!(draft.get("level").and_then(Value::as_str), Some("warning"));
        assert_eq!(draft.get("complete"), Some(&Value::Bool(true)));

        let exit = interrupted_notice(
            Some("agent-1"),
            1_000.5,
            Interruption::Exit,
            Some("The provider crashed"),
        );
        assert_eq!(exit.get("agent").and_then(Value::as_str), Some("agent-1"));
        let draft = exit.get("draft").expect("draft");
        assert_eq!(
            draft.get("code").and_then(Value::as_str),
            Some("agent_stopped")
        );
        assert_eq!(
            draft.get("text").and_then(Value::as_str),
            Some("The provider crashed")
        );
    }

    #[test]
    fn a_fractional_time_keeps_its_own_item() {
        let first = interrupted_notice(None, 10.5, Interruption::Exit, None);
        let second = interrupted_notice(None, 11.0, Interruption::Exit, None);
        assert_ne!(first.get("item"), second.get("item"));
        assert_eq!(
            first.get("item").and_then(Value::as_str),
            Some("liveness:stopped:10.5")
        );
    }
}
