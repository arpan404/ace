// SPDX-License-Identifier: Apache-2.0
//! `guest-admission.ts` (E5.4d): the refusals for a guest thread (ADR 0105) and a host thread
//! (ADR 0121), and a retired bot thread left in a home.

use ace_json::Value;

use super::refusal;

/// Commands that would start or carry on an agent turn: a guest thread has no agent here.
const STARTS_AGENT: [&str; 8] = [
    "thread.send",
    "thread.resume",
    "thread.limit",
    "thread.switch",
    "thread.merge",
    "thread.goal.set",
    "queue.resume",
    "queue.resend",
];

/// The refusal for a command on a guest thread, or none when it may go on.
pub fn guest_refusal(command_id: &str, kind: &str, guest: Option<&Value>) -> Option<Value> {
    let guest = guest?;
    if !STARTS_AGENT.contains(&kind) {
        return None;
    }
    let name = guest
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let from = if name.is_empty() {
        "another machine"
    } else {
        name
    };
    Some(refusal(
        command_id,
        "guest_thread",
        "No agent here",
        &format!("This thread holds work from {from}; it has no agent here."),
    ))
}

/// The refusal for a command on a host thread. Spade's own thread (ADR 0121) refuses what would
/// run an agent and a fork; a `spade-bot` thread refuses every command, so it stays inert.
pub fn host_refusal(command_id: &str, kind: &str, host: Option<&str>) -> Option<Value> {
    if host == Some("spade-bot") {
        return Some(refusal(
            command_id,
            "host_thread",
            "A Spade bot's old thread",
            "Spade bots no longer run here; talk to the bot in Spade.",
        ));
    }
    if host != Some("spade") || (!STARTS_AGENT.contains(&kind) && kind != "thread.fork") {
        return None;
    }
    Some(refusal(
        command_id,
        "host_thread",
        "Spade's own thread",
        "Spade works through this thread; nothing runs in it.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    #[test]
    fn a_spade_bots_old_thread_refuses_every_command_so_it_stays_inert() {
        for kind in [
            "thread.send",
            "thread.resume",
            "thread.interrupt",
            "thread.rename",
        ] {
            let refusal = host_refusal("cmd-1", kind, Some("spade-bot")).expect(kind);
            assert_eq!(
                refusal.get("error").and_then(Value::as_str),
                Some("host_thread")
            );
        }
    }

    #[test]
    fn spades_host_thread_refuses_only_what_would_run_an_agent_and_other_threads_take_all() {
        let refused = host_refusal("cmd-1", "thread.send", Some("spade")).expect("refused");
        assert_eq!(
            refused.get("title").and_then(Value::as_str),
            Some("Spade's own thread")
        );
        assert_eq!(
            refused.get("detail").and_then(Value::as_str),
            Some("Spade works through this thread; nothing runs in it.")
        );
        assert!(
            host_refusal("cmd-1", "thread.rename", Some("spade")).is_none(),
            "a rename runs nothing"
        );
        for kind in [
            "thread.send",
            "thread.resume",
            "thread.interrupt",
            "thread.rename",
        ] {
            assert!(host_refusal("cmd-1", kind, None).is_none());
        }
    }

    #[test]
    fn a_guest_thread_refuses_the_commands_that_would_run_an_agent() {
        let guest = value(r#"{"name":"Rijan's MacBook"}"#);
        let refusal = guest_refusal("cmd-1", "thread.send", Some(&guest)).expect("refused");
        assert_eq!(
            refusal.get("detail").and_then(Value::as_str),
            Some("This thread holds work from Rijan's MacBook; it has no agent here.")
        );
        let unnamed = value("{}");
        let refusal = guest_refusal("cmd-1", "queue.resend", Some(&unnamed)).expect("refused");
        assert_eq!(
            refusal.get("detail").and_then(Value::as_str),
            Some("This thread holds work from another machine; it has no agent here.")
        );
        assert!(guest_refusal("cmd-1", "thread.rename", Some(&guest)).is_none());
        assert!(guest_refusal("cmd-1", "thread.send", None).is_none());
    }
}
