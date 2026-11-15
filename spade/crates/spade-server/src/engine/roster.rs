//! What the roster shows for an agent without loading its transcript (ADR 0127): its latest
//! message, its state, and a few plain words on what it is doing. Pure functions over events.

use spade_core::event::{FromAgent, Known};
use spade_core::{Event, Transcript};
use spade_store::StoredEvent;

/// The longest roster preview, in characters.
pub const PREVIEW: usize = 200;

/// The latest message in a conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastMessage {
    /// Whether this agent wrote it (`agent`), or it came to the agent (`person`, or another bot
    /// when `from_agent` is set).
    pub by_agent: bool,
    /// Its plain-text preview ([`preview`]): no markdown, links as their words.
    pub text: String,
    pub at_ms: i64,
    /// The event it is, for the seen cursor.
    pub seq: i64,
    pub from_agent: Option<FromAgent>,
}

/// The agent finished and the person hasn't seen what it said: it is idle, and its own latest
/// message is past the conversation's seen cursor. Never while any of its work runs or waits.
pub fn unseen(state: State, last: Option<&LastMessage>, seen: Option<i64>) -> bool {
    state == State::Idle && last.is_some_and(|m| m.by_agent && m.seq > seen.unwrap_or(0))
}

/// What the agent is doing, for the roster.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Idle,
    Working,
    /// Needs the person: an approval is pending.
    Waiting,
}

impl State {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::Waiting => "waiting",
        }
    }

    /// From the folded transcript: waiting beats working, and background jobs count as working,
    /// so an agent is never shown idle while any of its work runs.
    pub fn of(transcript: &Transcript) -> Self {
        // A helper waiting on the person (ADR 0152) counts, even after the reply that started it.
        if transcript.waiting_on_you() {
            Self::Waiting
        } else if transcript.open_reply().is_some() || !transcript.jobs.is_empty() {
            Self::Working
        } else {
            Self::Idle
        }
    }
}

/// The latest message: the person's (or another bot's) or the agent's reply text, never tool
/// output, cut to [`PREVIEW`] characters of plain text.
pub fn last_message(events: &[StoredEvent]) -> Option<LastMessage> {
    // A routine's message is its label, not something the person said; a heartbeat and its quiet
    // answer are shown as nothing (ADR 0129).
    let silent = spade_core::routine::silent_replies(events.iter().map(|e| &e.event));
    events.iter().rev().find_map(|stored| {
        let Event::Known(known) = &stored.event else {
            return None;
        };
        let (by_agent, text, from_agent) = match known {
            Known::UserMessage {
                from_routine: Some(_),
                ..
            } => return None,
            Known::ReplyFinished { reply, .. } if silent.contains(reply) => return None,
            Known::UserMessage {
                text,
                images,
                from_agent,
                ..
            } => {
                let text = if text.trim().is_empty() && !images.is_empty() {
                    "Sent an image".to_owned()
                } else {
                    text.clone()
                };
                (false, text, from_agent.clone())
            }
            Known::ReplyFinished { text, .. }
            | Known::ReplyStopped { text, .. }
            | Known::ReplyFailed { text, .. }
            | Known::ReplyInterrupted { text, .. } => (true, text.clone(), None),
            _ => return None,
        };
        let text = preview(&text, PREVIEW);
        (!text.is_empty()).then_some(LastMessage {
            by_agent,
            text,
            at_ms: stored.at_ms,
            seq: stored.seq,
            from_agent,
        })
    })
}

/// Markdown reduced to plain words on one line: no emphasis marks, headings, quotes or fences.
pub fn plain(text: &str, longest: usize) -> String {
    let mut out = String::new();
    for line in text.lines() {
        let line = line.trim_start_matches(['#', '>', ' ', '\t']);
        if line.starts_with("```") {
            continue;
        }
        for word in line.split_whitespace() {
            let word: String = word.chars().filter(|c| !matches!(c, '*' | '`')).collect();
            if word.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(&word);
        }
    }
    if out.chars().count() > longest {
        out = out.chars().take(longest - 1).collect::<String>() + "…";
    }
    out
}

/// A message as the list previews it: [`plain`], and links and images as their words, list
/// marks, strike-through and underscore emphasis gone. Only for the app; the model never reads
/// it, so it may change freely ([`plain`] reaches the model through `bots_list`).
pub fn preview(text: &str, longest: usize) -> String {
    let mut lines = String::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        let trimmed = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
            .or_else(|| {
                let digits = trimmed.find(|c: char| !c.is_ascii_digit())?;
                (digits > 0)
                    .then(|| trimmed[digits..].strip_prefix(". "))
                    .flatten()
            })
            .unwrap_or(trimmed);
        let trimmed = trimmed
            .strip_prefix("[ ] ")
            .or_else(|| trimmed.strip_prefix("[x] "))
            .unwrap_or(trimmed);
        let linked = links_as_words(trimmed);
        let words: Vec<&str> = linked
            .split_whitespace()
            .map(|word| {
                let inner = word.trim_matches('_');
                // `_emphasis_`, `__strong__`; never `snake_case` or a lone `_`.
                if !inner.is_empty() && word.starts_with('_') && word.ends_with('_') {
                    inner
                } else {
                    word
                }
            })
            .collect();
        lines.push_str(&words.join(" ").replace("~~", ""));
        lines.push('\n');
    }
    plain(&lines, longest)
}

/// `[words](url)` → `words`, `![alt](url)` → `alt`.
fn links_as_words(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        let image = open > 0 && rest[..open].ends_with('!');
        let before = if image {
            &rest[..open - 1]
        } else {
            &rest[..open]
        };
        let after = &rest[open + 1..];
        let link = after.find("](").and_then(|close| {
            let target = &after[close + 2..];
            target.find(')').map(|end| (close, close + 2 + end + 1))
        });
        // `[a] and [b](u)`: the first bracket is not the link's.
        let link = link.filter(|(close, _)| !after[..*close].contains(']'));
        match link {
            Some((close, end)) => {
                out.push_str(before);
                out.push_str(&after[..close]);
                rest = &after[end..];
            }
            None => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A few plain words on what running `tool` means. Never its arguments. `bot` is the name of the
/// bot a `bot_message` goes to.
pub fn tool_status(tool: &str, bot: Option<&str>) -> String {
    match tool {
        "web_search" => "Searching the web".to_owned(),
        "web_fetch" => "Reading a page".to_owned(),
        "todo" => "Planning".to_owned(),
        "skill_search" | "skill_load" => "Looking at skills".to_owned(),
        spade_core::tools::TOOL_SEARCH => "Looking for a tool".to_owned(),
        "bots_list" => "Checking the other bots".to_owned(),
        spade_core::helper::TOOL => "Starting a helper".to_owned(),
        "bot_message" => match bot {
            Some(name) => format!("Asking {name}"),
            None => "Asking another bot".to_owned(),
        },
        // The same plain words the activity log uses ("Using an app on the screen").
        other => spade_core::activity::words::tool_words(other).doing,
    }
}

pub const THINKING: &str = "Thinking";
/// A model step failed before anything streamed and is being sent again.
pub const RETRYING: &str = "Retrying";
pub const WAITING_FOR_YOU: &str = "Waiting for you";
pub const IN_BACKGROUND: &str = "Working in the background";

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seq: i64, event: Event) -> StoredEvent {
        StoredEvent {
            seq,
            at_ms: seq * 10,
            event,
        }
    }

    #[test]
    fn the_latest_message_is_the_reply_text_never_tool_output() {
        let events = vec![
            at(1, Event::user_message("Find **flights** to Oslo")),
            at(2, Event::reply_started("r1", "e/m")),
            at(
                3,
                Event::Known(Known::ToolFinished {
                    reply: "r1".into(),
                    call_id: "c".into(),
                    name: "web_search".into(),
                    content: "raw results".into(),
                    is_error: false,
                    uncertain: false,
                    images: Vec::new(),
                    untrusted: false,
                }),
            ),
        ];
        let last = last_message(&events);
        assert_eq!(
            last.as_ref()
                .map(|m| (m.by_agent, m.text.as_str(), m.at_ms)),
            Some((false, "Find flights to Oslo", 10))
        );
        let mut events = events;
        events.push(at(
            4,
            Event::Known(Known::ReplyFinished {
                reply: "r1".into(),
                text: "# Found\n\n```\ncode\n```\nTwo `options`.".into(),
                input_tokens: None,
                output_tokens: None,
                cost_micros: 0,
            }),
        ));
        let last = last_message(&events);
        assert_eq!(
            last.map(|m| (m.by_agent, m.text)),
            Some((true, "Found code Two options.".to_owned()))
        );
    }

    #[test]
    fn a_preview_is_plain_text_with_links_as_their_words() {
        let cases = [
            (
                "See [the plan](https://x.dev/p) and ![chart](c.png).",
                "See the plan and chart.",
            ),
            ("- first\n2. second\n- [x] done", "first second done"),
            (
                "~~old~~ _new_ and __bold__ but snake_case stays",
                "old new and bold but snake_case stays",
            ),
            ("A [lone] bracket [stays", "A [lone] bracket [stays"),
            ("[a] and [b](https://x.dev)", "[a] and b"),
        ];
        for (text, expected) in cases {
            assert_eq!(preview(text, PREVIEW), expected, "{text}");
        }
    }

    #[test]
    fn finished_and_not_seen_holds_only_while_idle_with_its_own_reply_past_the_cursor() {
        let mine = |seq| LastMessage {
            by_agent: true,
            text: "Done".into(),
            at_ms: 0,
            seq,
            from_agent: None,
        };
        assert!(unseen(State::Idle, Some(&mine(5)), Some(4)));
        assert!(unseen(State::Idle, Some(&mine(5)), None));
        assert!(!unseen(State::Idle, Some(&mine(5)), Some(5)));
        assert!(
            !unseen(State::Working, Some(&mine(5)), Some(4)),
            "still working"
        );
        assert!(
            !unseen(State::Waiting, Some(&mine(5)), Some(4)),
            "waiting on you"
        );
        let yours = LastMessage {
            by_agent: false,
            ..mine(5)
        };
        assert!(
            !unseen(State::Idle, Some(&yours), Some(4)),
            "the person's own message"
        );
    }

    #[test]
    fn a_long_message_is_cut_to_the_preview_length() {
        let events = vec![at(1, Event::user_message("word ".repeat(100)))];
        let text = last_message(&events).map(|m| m.text).unwrap_or_default();
        assert_eq!(text.chars().count(), PREVIEW);
        assert!(text.ends_with('…'));
    }
}
