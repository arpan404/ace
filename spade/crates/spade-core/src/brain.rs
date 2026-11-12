//! A bot whose model is one of the person's subscriptions (ADR 0133, docs/cli-brains.md): the
//! model reference, and what each turn of the CLI's session is sent. The CLI keeps its own
//! context, so a turn carries only what arrived since its last one.

use crate::context::{self, SYSTEM};
use crate::event::{Event, Known};

/// Every subscription model reference starts with this.
pub const PREFIX: &str = "cli:";

/// The providers ace can run, by the ids ace uses.
pub const PROVIDERS: &[&str] = &[
    "claude",
    "codex",
    "opencode",
    "cursor",
    "antigravity",
    "acp",
    "pi",
];

/// How a CLI reaches the bot's own tools: through two of ace's tools, since its own tools and
/// ace's are the session's already.
pub const TOOLS_GUIDE: &str = "You run inside a coding-agent CLI on the person's subscription, as \
one of their Spade bots. Your own Spade tools (your notes, your workspace, your routines, other \
bots, the person's connected apps, and ask_user for a question to the person) are reached through \
ace's spade_tools tool, which lists them with their input schemas, and spade_call, which runs one \
as {tool, arguments}. Spade may ask the person before a call runs; spade_call then waits for their \
answer. Change things only through these tools or ace's own tools, never by editing files \
yourself.";

/// `cli:<provider>/<model>` or `cli:<provider>@<account>/<model>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliModel {
    pub provider: String,
    pub account: Option<String>,
    pub model: String,
}

impl CliModel {
    /// The reference read, or `None` when it is not a valid subscription model.
    pub fn parse(reference: &str) -> Option<Self> {
        let rest = reference.strip_prefix(PREFIX)?;
        let (who, model) = rest.split_once('/')?;
        let (provider, account) = match who.split_once('@') {
            Some((provider, account)) => (provider, Some(account)),
            None => (who, None),
        };
        let valid_id = |id: &str| {
            !id.is_empty()
                && id.len() <= 128
                && !id.chars().any(|c| c.is_control() || c.is_whitespace())
        };
        if !PROVIDERS.contains(&provider)
            || model.trim().is_empty()
            || model.len() > 256
            || model.chars().any(char::is_control)
            || account.is_some_and(|a| !valid_id(a) || a.contains('/'))
        {
            return None;
        }
        Some(Self {
            provider: provider.to_owned(),
            account: account.map(str::to_owned),
            model: model.to_owned(),
        })
    }

    /// Whether `reference` names a subscription rather than an endpoint.
    pub fn is(reference: &str) -> bool {
        reference.starts_with(PREFIX)
    }
}

/// What the next turn of a bot's CLI session is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    /// Spade's rules, the task and the indexes, as an endpoint model's system prompt.
    pub instructions: String,
    /// Whether they differ from the ones the session's last turn was built from.
    pub changed: bool,
    /// What arrived since the session's last turn.
    pub message: String,
    /// How many events this turn was built from, stored as the step's `seen`.
    pub seen: usize,
}

/// The next turn from the stored events: everything after the last step's `seen` that the
/// person, another bot, a routine or a finished job sent. `None` when nothing new arrived.
pub fn next_turn(events: &[Event]) -> Option<Turn> {
    let previous = events.iter().rev().find_map(|event| match event {
        Event::Known(Known::StepFinished {
            seen: Some(seen), ..
        }) => Some(*seen),
        _ => None,
    });
    let since = previous.unwrap_or(0).min(events.len());
    // The person's answer to an `ask_user` question went to the CLI as that call's result.
    let mut asking = events[..since]
        .iter()
        .rev()
        .take_while(|e| {
            !matches!(
                e,
                Event::Known(Known::UserMessage {
                    from_agent: None,
                    ..
                })
            )
        })
        .any(|e| matches!(e, Event::Known(Known::QuestionAsked { .. })));
    let parts: Vec<String> = events[since..]
        .iter()
        .filter_map(|event| match event {
            Event::Known(Known::QuestionAsked { .. }) => {
                asking = true;
                None
            }
            Event::Known(Known::UserMessage {
                from_agent: None, ..
            }) if asking => {
                asking = false;
                None
            }
            Event::Known(Known::UserMessage {
                text,
                context,
                images,
                from_agent,
                from_routine,
                from_group,
            }) => {
                let mut text = context::person_text(
                    text,
                    context.as_deref(),
                    from_agent.as_ref(),
                    from_routine.as_deref(),
                    from_group.as_deref(),
                );
                if !images.is_empty() {
                    text.push_str(&format!(
                        "\n\n[The person attached {} image(s); this bot can't see images yet.]",
                        images.len()
                    ));
                }
                Some(text)
            }
            Event::Known(Known::JobFinished {
                job,
                name,
                content,
                is_error,
                ..
            }) => Some(context::job_result(job, name, content, *is_error)),
            _ => None,
        })
        .collect();
    // A CLI turn is done only when its last step made no call (`step` stores calls as steps of
    // their own while the turn goes on). One whose last step is a call was cut off mid-turn.
    let mut parts = parts;
    match cut_off(events) {
        Some(Cut::StillOpen) => parts.insert(0, CUT_OFF.to_owned()),
        Some(Cut::Ended) if !parts.is_empty() => parts.insert(0, ENDED_EARLY.to_owned()),
        _ => {}
    }
    if parts.is_empty() {
        return None;
    }
    let now = instructions(events);
    let changed =
        previous.is_some_and(|seen| instructions(&events[..seen.min(events.len())]) != now);
    Some(Turn {
        instructions: now,
        changed,
        message: parts.join("\n\n"),
        seen: events.len(),
    })
}

/// Why the bot's latest reply on a subscription failed (signed out, out of quota), while no later
/// reply has finished: the one line its roster row shows. `None` otherwise.
pub fn problem<'a, I>(events: I) -> Option<&'a str>
where
    I: IntoIterator<Item = &'a Event>,
    I::IntoIter: DoubleEndedIterator + Clone,
{
    let events = events.into_iter();
    let (reply, error) = events.clone().rev().find_map(|event| match event {
        Event::Known(Known::ReplyFailed { reply, error, .. }) => Some(Some((reply, error))),
        Event::Known(
            Known::ReplyFinished { .. }
            | Known::ReplyStopped { .. }
            | Known::ReplyInterrupted { .. },
        ) => Some(None),
        _ => None,
    })??;
    let on_cli = events.clone().any(|event| {
        matches!(event, Event::Known(Known::ReplyStarted { reply: r, model }) if r == reply && CliModel::is(model))
    });
    on_cli.then_some(error.as_str())
}

/// What a resumed CLI turn is told when Spade paused or restarted in the middle of it.
pub const CUT_OFF: &str = "[Your last turn was cut off before you finished (Spade paused or \
restarted). A call you made may or may not have taken effect: check what is already done, then \
carry on.]";

/// What the next turn is told when the last one ended mid-turn (a stop, a crash).
pub const ENDED_EARLY: &str = "[Your last turn ended before you finished (the person stopped it, \
or Spade restarted). A call you made may or may not have taken effect.]";

enum Cut {
    /// The reply it belongs to is still open: it resumes.
    StillOpen,
    /// Its reply was closed (stopped, interrupted, failed).
    Ended,
}

/// Whether the session's last turn stopped after a call instead of finishing.
fn cut_off(events: &[Event]) -> Option<Cut> {
    let at = events
        .iter()
        .rposition(|event| matches!(event, Event::Known(Known::StepFinished { .. })))?;
    let Event::Known(Known::StepFinished { reply, calls, .. }) = &events[at] else {
        return None;
    };
    if calls.is_empty() {
        return None;
    }
    let closed = events[at..].iter().any(|event| {
        matches!(event, Event::Known(
            Known::ReplyFinished { reply: r, .. }
            | Known::ReplyStopped { reply: r, .. }
            | Known::ReplyFailed { reply: r, .. }
            | Known::ReplyInterrupted { reply: r, .. }
        ) if r == reply)
    });
    Some(if closed { Cut::Ended } else { Cut::StillOpen })
}

/// The standing instructions for a CLI bot: an endpoint bot's, plus how to reach its tools.
pub fn instructions(events: &[Event]) -> String {
    context::instructions(&format!("{SYSTEM}\n\n{TOOLS_GUIDE}"), events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{Call, Tokens};

    #[test]
    fn subscription_models_name_a_known_provider_and_an_account_without_slashes() {
        let cases = [
            (
                "cli:codex/gpt-6.1-sol",
                Some(("codex", None, "gpt-6.1-sol")),
            ),
            (
                "cli:claude@work/opus-5.5",
                Some(("claude", Some("work"), "opus-5.5")),
            ),
            (
                "cli:opencode/openai/gpt-6",
                Some(("opencode", None, "openai/gpt-6")),
            ),
            ("cli:nope/x", None),
            ("cli:codex/", None),
            ("cli:codex@/x", None),
            ("codex/gpt", None),
            ("cli:codex", None),
        ];
        for (reference, expected) in cases {
            let parsed = CliModel::parse(reference);
            let got = parsed
                .as_ref()
                .map(|m| (m.provider.as_str(), m.account.as_deref(), m.model.as_str()));
            assert_eq!(got, expected, "{reference}");
        }
    }

    fn step(seen: usize) -> Event {
        Event::Known(Known::StepFinished {
            reply: "r1".into(),
            text: "Done".into(),
            calls: Vec::new(),
            thoughts: Vec::new(),
            usage: Tokens::default(),
            cost_micros: 0,
            seen: Some(seen),
        })
    }

    fn configured(task: &str) -> Event {
        Event::Known(Known::AgentConfigured {
            task: task.into(),
            model: "cli:codex/m".into(),
        })
    }

    #[test]
    fn a_turn_cut_off_after_a_call_resumes_with_a_note_and_is_never_taken_as_done() {
        let call_step = Event::Known(Known::StepFinished {
            reply: "r1".into(),
            text: "Noting".into(),
            calls: vec![Call {
                id: "call_1".into(),
                name: "note_down".into(),
                arguments: serde_json::json!({}),
            }],
            thoughts: Vec::new(),
            usage: Tokens::default(),
            cost_micros: 0,
            seen: Some(2),
        });
        let mut events = vec![
            Event::user_message("Note milk"),
            Event::reply_started("r1", "cli:codex/m"),
            call_step,
            Event::Known(Known::ToolFinished {
                reply: "r1".into(),
                call_id: "call_1".into(),
                name: "note_down".into(),
                content: "noted".into(),
                is_error: false,
                uncertain: false,
                images: Vec::new(),
                untrusted: false,
            }),
            Event::Known(Known::TurnPaused { reply: "r1".into() }),
        ];
        let resumed = next_turn(&events).map(|turn| turn.message);
        assert_eq!(resumed.as_deref(), Some(CUT_OFF));
        // Once its reply closed, the note goes with the next message only.
        events.push(Event::reply_ended(crate::ReplyEnd::Stopped, "r1", ""));
        assert_eq!(next_turn(&events), None);
        events.push(Event::user_message("Again"));
        let next = next_turn(&events).map(|turn| turn.message);
        assert_eq!(next, Some(format!("{ENDED_EARLY}\n\nAgain")));
    }

    #[test]
    fn a_failed_subscription_reply_shows_until_a_later_reply_finishes() {
        let failed = |reply: &str| {
            Event::Known(Known::ReplyFailed {
                reply: reply.into(),
                text: String::new(),
                error: "Codex is signed out.".into(),
            })
        };
        let mut events = vec![
            Event::user_message("Hi"),
            Event::reply_started("r1", "cli:codex/m"),
            failed("r1"),
        ];
        assert_eq!(problem(&events), Some("Codex is signed out."));
        events.push(Event::reply_started("r2", "cli:codex/m"));
        events.push(Event::Known(Known::ReplyFinished {
            reply: "r2".into(),
            text: "Hello".into(),
            input_tokens: None,
            output_tokens: None,
            cost_micros: 0,
        }));
        assert_eq!(problem(&events), None);
        // An endpoint's failure is the conversation's to show, not the roster's.
        events.push(Event::reply_started("r3", "openai/gpt"));
        events.push(failed("r3"));
        assert_eq!(problem(&events), None);
    }

    #[test]
    fn each_turn_sends_only_what_arrived_since_the_last_and_says_when_instructions_changed()
    -> Result<(), &'static str> {
        let mut events = vec![
            configured("Keep notes"),
            Event::user_message("Hello"),
            Event::reply_started("r1", "cli:codex/m"),
        ];
        let first = next_turn(&events).ok_or("a first turn")?;
        assert!(first.instructions.contains("Keep notes"));
        assert!(first.instructions.contains("spade_call"));
        assert!(!first.changed);
        assert_eq!(first.message, "Hello");
        events.push(step(first.seen));
        assert_eq!(next_turn(&events), None, "nothing new arrived");

        events.push(Event::user_message("And then?"));
        let second = next_turn(&events).ok_or("a second turn")?;
        assert_eq!(second.message, "And then?");
        assert!(!second.changed);
        events.push(step(second.seen));

        events.push(configured("Keep tidy notes"));
        events.push(Event::user_message("Tidy up"));
        events.push(Event::reply_started("r2", "cli:codex/m"));
        let third = next_turn(&events).ok_or("a third turn")?;
        assert!(third.changed);
        assert!(third.instructions.contains("Keep tidy notes"));
        Ok(())
    }
}
