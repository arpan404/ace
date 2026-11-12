//! Groups (ADR 0132): who a person's message goes to, what a run may still ask, which asks are
//! open, and how a group message reads to the bot answering it. Decided from a group's stored
//! events only.

use crate::event::{Event, FromGroup, GroupBot, Known};

/// Asks one run allows, the person's own included.
pub const MOST_ASKS: usize = 8;
/// The deepest chain in a run: person to lead (1), lead to member (2), member to member (3).
pub const MOST_DEPTH: u32 = 3;
/// Group messages a recipient is shown with the one it answers.
pub const RECENT: usize = 12;
/// Characters of each earlier message shown.
const RECENT_CHARS: usize = 600;

/// Why an ask is refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Stopped,
    TooMany,
    TooDeep,
}

impl Refusal {
    /// Words for the bot that asked.
    pub fn words(&self) -> String {
        match self {
            Self::Stopped => "Refused: the person stopped this group's work. Answer with what \
                              you have."
                .to_owned(),
            Self::TooMany => format!(
                "Refused: this group's message already had {MOST_ASKS} asks. Answer with what \
                 you have."
            ),
            Self::TooDeep => format!(
                "Refused: this would be a chain of more than {MOST_DEPTH} asks. Answer with \
                 what you have."
            ),
        }
    }
}

/// Whether one more ask at `depth` fits run `run`.
pub fn admit(events: &[Event], run: &str, depth: u32) -> Result<(), Refusal> {
    let mut asks = 0;
    for event in events {
        match event {
            Event::Known(Known::GroupStopped { run: r }) if r == run => {
                return Err(Refusal::Stopped);
            }
            Event::Known(Known::GroupAsked { run: r, .. }) if r == run => asks += 1,
            _ => {}
        }
    }
    if depth > MOST_DEPTH {
        return Err(Refusal::TooDeep);
    }
    if asks >= MOST_ASKS {
        return Err(Refusal::TooMany);
    }
    Ok(())
}

/// An ask that has not ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAsk {
    pub run: String,
    pub ask: String,
    pub to: GroupBot,
    pub depth: u32,
    /// Waiting for the bot's machine to come online.
    pub queued: bool,
}

/// Asks asked and not yet answered, oldest first.
pub fn open_asks(events: &[Event]) -> Vec<OpenAsk> {
    let mut open: Vec<OpenAsk> = Vec::new();
    for event in events {
        match event {
            Event::Known(Known::GroupAsked {
                run,
                ask,
                to,
                depth,
                ..
            }) => open.push(OpenAsk {
                run: run.clone(),
                ask: ask.clone(),
                to: to.clone(),
                depth: *depth,
                queued: false,
            }),
            Event::Known(Known::GroupQueued { ask, .. }) => {
                if let Some(entry) = open.iter_mut().find(|o| &o.ask == ask) {
                    entry.queued = true;
                }
            }
            Event::Known(Known::GroupAnswered { ask, .. }) => open.retain(|o| &o.ask != ask),
            _ => {}
        }
    }
    open
}

/// The members a message mentions with `@Name` (any case; the longest name wins where one name
/// begins another), as indexes into `names`, in the order first mentioned, each once.
pub fn mentions(text: &str, names: &[&str]) -> Vec<usize> {
    let lower = text.to_lowercase();
    let mut order: Vec<usize> = Vec::new();
    let mut by_length: Vec<usize> = (0..names.len()).collect();
    by_length.sort_by_key(|&i| std::cmp::Reverse(names[i].chars().count()));
    for (at, _) in lower.match_indices('@') {
        // A mention starts a word: `me@example.com` mentions nobody.
        let before = lower[..at].chars().next_back();
        if before.is_some_and(|c| c.is_alphanumeric()) {
            continue;
        }
        let rest = &lower[at + 1..];
        let hit = by_length.iter().copied().find(|&i| {
            let name = names[i].to_lowercase();
            !name.is_empty()
                && rest.starts_with(&name)
                && !rest[name.len()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_alphanumeric())
        });
        if let Some(index) = hit
            && !order.contains(&index)
        {
            order.push(index);
        }
    }
    order
}

/// The group's latest messages before the one being answered, as lines for a recipient's
/// context, and whether any line is another bot's (whose words are untrusted). `me` is the
/// recipient, whose own lines don't count.
pub fn recent(events: &[Event], me: &GroupBot, before_run: &str) -> (String, bool) {
    let messages: Vec<(&Option<GroupBot>, &String)> = events
        .iter()
        .filter_map(|event| match event {
            Event::Known(Known::GroupMessage { run, text, from }) if run != before_run => {
                Some((from, text))
            }
            _ => None,
        })
        .collect();
    let start = messages.len().saturating_sub(RECENT);
    let mut untrusted = false;
    let lines: Vec<String> = messages[start..]
        .iter()
        .map(|(from, text)| {
            let who = match from {
                None => "the person".to_owned(),
                Some(bot) if same(bot, me) => "you".to_owned(),
                Some(bot) => {
                    untrusted = true;
                    bot.name.clone()
                }
            };
            let text: String = text.chars().take(RECENT_CHARS).collect();
            format!("{who}: {text}")
        })
        .collect();
    (lines.join("\n"), untrusted)
}

fn same(a: &GroupBot, b: &GroupBot) -> bool {
    a.id == b.id && a.machine == b.machine
}

/// A group message as the bot answering it reads it.
pub fn framed(from: &FromGroup, text: &str) -> String {
    let place = from
        .machine
        .as_ref()
        .map(|m| format!(" machine=\"{m}\""))
        .unwrap_or_default();
    let ask = if from.machine.is_none() {
        " To hand part of it to another member, use group_ask."
    } else {
        ""
    };
    format!(
        "<group name=\"{}\" id=\"{}\"{place}>\nYour reply is posted in this group as your \
         message.{ask}\n\n{text}\n</group>",
        from.name, from.id
    )
}

#[cfg(test)]
mod tests;
