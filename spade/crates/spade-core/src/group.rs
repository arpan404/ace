//! Groups (ADR 0132): who a person's message goes to, what a run may still ask, which asks are
//! open, and how a group message reads to the bot answering it. Decided from a group's stored
//! events only.

use crate::event::{Event, FromGroup, GroupBot, Known};

pub mod files;

/// The deepest chain in a run (person to lead is 1, lead to member 2, and so on): a guard against
/// a runaway chain, not a budget. A run takes as many asks as its work needs (ADR 0158); an ask
/// back to a bot already waiting up the chain is refused as a cycle.
pub const MOST_DEPTH: u32 = 16;
/// Group messages a recipient is shown with the one it answers.
pub const RECENT: usize = 12;
/// Characters of each earlier message shown.
const RECENT_CHARS: usize = 600;

/// Why an ask is refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Stopped,
    TooDeep,
    /// The bot asked is already waiting on this chain of asks: it could never answer.
    Cycle,
}

impl Refusal {
    /// Words for the bot that asked.
    pub fn words(&self) -> String {
        match self {
            Self::Stopped => "Refused: the person stopped this club's work. Answer with what \
                              you have."
                .to_owned(),
            Self::TooDeep => format!(
                "Refused: this would be a chain of more than {MOST_DEPTH} asks. Answer with \
                 what you have."
            ),
            Self::Cycle => "Refused: that bot is waiting on your answer already, further up this \
                            chain of asks. Answer with what you have, or ask someone else."
                .to_owned(),
        }
    }
}

/// Whether one more ask, by `by` (the person when `None`) to `to` at `depth`, fits run `run`.
pub fn admit(
    events: &[Event],
    run: &str,
    depth: u32,
    by: Option<&GroupBot>,
    to: &GroupBot,
) -> Result<(), Refusal> {
    let stopped = events
        .iter()
        .any(|e| matches!(e, Event::Known(Known::GroupStopped { run: r }) if r == run));
    if stopped {
        return Err(Refusal::Stopped);
    }
    if depth > MOST_DEPTH {
        return Err(Refusal::TooDeep);
    }
    // Up the chain: the open ask `by` is answering, then the one its asker is answering, ...
    let open: Vec<OpenAsk> = open_asks(events)
        .into_iter()
        .filter(|o| o.run == run)
        .collect();
    let mut asker = by;
    for _ in 0..=open.len() {
        let Some(bot) = asker else { break };
        if bot.id == to.id {
            return Err(Refusal::Cycle);
        }
        asker = open
            .iter()
            .rev()
            .find(|o| o.to.id == bot.id)
            .and_then(|o| o.by.as_ref());
    }
    Ok(())
}

/// An ask that has not ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAsk {
    pub run: String,
    pub ask: String,
    pub to: GroupBot,
    /// Who asked; the person when `None`.
    pub by: Option<GroupBot>,
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
                by,
            }) => open.push(OpenAsk {
                run: run.clone(),
                ask: ask.clone(),
                to: to.clone(),
                by: by.clone(),
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

/// What one run has said so far (ADR 0194, an ask from an ace thread): every bot's message
/// posted in it, in order; its asks still open; how asks that ended without an answer ended; and
/// whether the person stopped it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunView {
    pub replies: Vec<(GroupBot, String)>,
    pub open: Vec<OpenAsk>,
    /// Any ask was made in the run.
    pub asked: bool,
    /// The words of each ask that ended `failed`, `refused` or `gave_up`, in order.
    pub failures: Vec<String>,
    pub stopped: bool,
}

/// [`RunView`] for run `run`, from a group's events.
pub fn run_view(events: &[Event], run: &str) -> RunView {
    let mut view = RunView::default();
    for event in events {
        match event {
            Event::Known(Known::GroupMessage {
                run: r,
                text,
                from: Some(bot),
                ..
            }) if r == run => view.replies.push((bot.clone(), text.clone())),
            Event::Known(Known::GroupAsked { run: r, .. }) if r == run => view.asked = true,
            Event::Known(Known::GroupAnswered {
                run: r,
                to,
                outcome,
                detail,
                ..
            }) if r == run && matches!(outcome.as_str(), "failed" | "refused" | "gave_up") => {
                view.failures.push(
                    detail
                        .clone()
                        .unwrap_or_else(|| format!("{} could not answer.", to.name)),
                );
            }
            Event::Known(Known::GroupStopped { run: r }) if r == run => view.stopped = true,
            _ => {}
        }
    }
    view.open = open_asks(events)
        .into_iter()
        .filter(|o| o.run == run)
        .collect();
    view
}

/// The most bots a club holds, the lead counted (ADR 0132, amended by ADR 0197).
pub const MOST_MEMBERS: usize = 32;
/// The most members one message of the person's asks at once. Past it, the lead is asked and
/// hands each named member its part, so a big club never runs every member on one message.
pub const MOST_ASKED: usize = 4;

/// Who a message of the person's goes to: `ask`, as indexes into the members, and the members it
/// named that the lead is left to hand on (`via_lead`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Routing {
    pub ask: Vec<usize>,
    pub via_lead: Vec<usize>,
}

/// Routes a message: to the members it mentions while they are at most [`MOST_ASKED`], else to
/// the lead with the named members left to it; with no mention, to the lead. `lead` is `None`
/// when the lead can't be asked here (it is on another machine): then at most [`MOST_ASKED`]
/// mentioned members are asked, the rest left out.
pub fn route(mentioned: &[usize], lead: Option<usize>) -> Routing {
    if mentioned.len() <= MOST_ASKED && !mentioned.is_empty() {
        return Routing {
            ask: mentioned.to_vec(),
            via_lead: Vec::new(),
        };
    }
    match lead {
        Some(lead) => Routing {
            ask: vec![lead],
            via_lead: mentioned.iter().copied().filter(|&m| m != lead).collect(),
        },
        None => Routing {
            ask: mentioned.iter().copied().take(MOST_ASKED).collect(),
            via_lead: Vec::new(),
        },
    }
}

/// What the lead reads after the person's words when it is to hand the message on.
pub fn hand_on_note(names: &[&str]) -> String {
    format!(
        "(Spade: the person named {} members, more than one message asks at once: {}. As the \
lead, hand each of them the part that is theirs with group_ask, a few at a time, and answer with \
what they say.)",
        names.len(),
        names.join(", ")
    )
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
            Event::Known(Known::GroupMessage {
                run, text, from, ..
            }) if run != before_run => Some((from, text)),
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

/// The replies of a member's own conversation that answer only its groups: every message it
/// answered since its last reply ended came from a group (ADR 0132). Each such message and its
/// answer live in the group's transcript, so the member's own chat, row and unseen mark leave
/// them out. A reply that also answers the person, a job or a wake is the member's own.
pub fn answering_replies<'a>(
    events: impl IntoIterator<Item = &'a Event>,
) -> std::collections::HashSet<String> {
    let mut answering = std::collections::HashSet::new();
    // Since the last reply ended: whether anything arrived, and whether all of it was a group's.
    let (mut inputs, mut only_groups) = (false, true);
    for event in events {
        let Event::Known(known) = event else {
            continue;
        };
        match known {
            Known::UserMessage { from_group, .. } => {
                inputs = true;
                only_groups &= from_group.is_some();
            }
            Known::JobFinished { .. } => (inputs, only_groups) = (true, false),
            known if crate::wake::is_note(known) => (inputs, only_groups) = (true, false),
            Known::ReplyFinished { reply, .. }
            | Known::ReplyStopped { reply, .. }
            | Known::ReplyFailed { reply, .. }
            | Known::ReplyInterrupted { reply, .. } => {
                if inputs && only_groups {
                    answering.insert(reply.clone());
                }
                (inputs, only_groups) = (false, true);
            }
            _ => {}
        }
    }
    answering
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
        "<group name=\"{}\" id=\"{}\"{place}>\nYour reply is posted in this club as your \
         message.{ask}\n\n{text}\n</group>",
        from.name, from.id
    )
}

#[cfg(test)]
mod tests;
