//! The morning brief (ADR 0165's amendment): once a day at the person's chosen time, what
//! finished since the last brief (each line opening the event it came from), what waits on the
//! person now (approvals and simple questions answerable in one tap), today's scheduled
//! routines, and spend since the last brief. Built from events with no model call.

use serde::{Deserialize, Serialize};

use crate::escalation::{one_line, sentence};
use crate::event::{Event, Known};
use crate::oversight::dollars;
use crate::question::{Kind, Standing, views};
use crate::transcript::Transcript;

use super::Category;
use super::notable::notable;

/// The most finished lines a brief lists; the rest are counted.
pub const MOST_FINISHED: usize = 20;
/// The most waiting requests a brief lists.
pub const MOST_WAITING: usize = 20;

/// One bot's part of the brief.
pub struct BotInput<'a> {
    pub agent: &'a str,
    pub name: &'a str,
    pub conversation: &'a str,
    /// Its whole history, oldest first, with when and as which seq each was stored.
    pub events: &'a [Event],
    pub at_ms: &'a [i64],
    pub seqs: &'a [i64],
    /// What it spent in the window.
    pub spent_micros: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Brief {
    pub from_ms: i64,
    pub to_ms: i64,
    pub finished: Vec<Finished>,
    #[serde(default)]
    pub more_finished: u32,
    pub waiting: Vec<Waiting>,
    pub today: Vec<Planned>,
    pub spend: Spend,
    /// What waited for the person (do not disturb, quiet hours, the budget) since last told.
    #[serde(default)]
    pub away: Vec<Away>,
}

/// Something that finished, with the event it came from: its evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finished {
    pub agent: String,
    pub name: String,
    pub conversation: String,
    pub seq: i64,
    pub at_ms: i64,
    pub text: String,
}

/// An open request, answerable from the brief when it is simple enough.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Waiting {
    pub agent: String,
    pub name: String,
    pub conversation: String,
    pub seq: i64,
    pub since_ms: i64,
    /// `approval` or `question`.
    pub kind: String,
    pub call_id: String,
    pub what: String,
    /// A question of one choice or a yes/no: `choice` or `confirm`; else absent and it opens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Planned {
    pub agent: String,
    pub name: String,
    pub routine: String,
    pub at_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spend {
    pub total_micros: u64,
    pub bots: Vec<BotSpend>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotSpend {
    pub agent: String,
    pub name: String,
    pub micros: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Away {
    pub agent: String,
    pub name: String,
    pub at_ms: i64,
    pub text: String,
}

/// The brief over `[from_ms, to_ms)`. `today` is the routines due before the day ends, `away`
/// what waited for the person, `total_micros` every bot's spend in the window.
pub fn build(
    from_ms: i64,
    to_ms: i64,
    bots: &[BotInput<'_>],
    mut today: Vec<Planned>,
    away: Vec<Away>,
    total_micros: u64,
) -> Brief {
    let mut finished = Vec::new();
    let mut waiting = Vec::new();
    let mut spend = Spend {
        total_micros,
        bots: Vec::new(),
    };
    for bot in bots {
        finished.extend(finished_of(bot, from_ms, to_ms));
        waiting.extend(waiting_of(bot));
        if bot.spent_micros > 0 {
            spend.bots.push(BotSpend {
                agent: bot.agent.to_owned(),
                name: bot.name.to_owned(),
                micros: bot.spent_micros,
            });
        }
    }
    finished.sort_by_key(|f| f.at_ms);
    let more_finished = u32::try_from(finished.len().saturating_sub(MOST_FINISHED)).unwrap_or(0);
    finished.truncate(MOST_FINISHED);
    waiting.sort_by_key(|w| w.since_ms);
    waiting.truncate(MOST_WAITING);
    today.sort_by_key(|p| p.at_ms);
    spend.bots.sort_by_key(|b| std::cmp::Reverse(b.micros));
    Brief {
        from_ms,
        to_ms,
        finished,
        more_finished,
        waiting,
        today,
        spend,
        away,
    }
}

fn finished_of(bot: &BotInput<'_>, from_ms: i64, to_ms: i64) -> Vec<Finished> {
    let mut lines = Vec::new();
    for (index, at) in bot.at_ms.iter().enumerate() {
        if *at < from_ms || *at >= to_ms {
            continue;
        }
        let Some(found) = notable(&bot.events[..=index], bot.at_ms, index) else {
            continue;
        };
        if !matches!(found.category, Category::Finished | Category::Routine) {
            continue;
        }
        lines.push(Finished {
            agent: bot.agent.to_owned(),
            name: bot.name.to_owned(),
            conversation: bot.conversation.to_owned(),
            seq: bot.seqs.get(index).copied().unwrap_or_default(),
            at_ms: *at,
            text: found.text,
        });
    }
    lines
}

fn waiting_of(bot: &BotInput<'_>) -> Vec<Waiting> {
    let at = |i: usize| bot.at_ms.get(i).copied().unwrap_or_default();
    let seq = |i: usize| bot.seqs.get(i).copied().unwrap_or_default();
    let find = |test: &dyn Fn(&Known) -> bool| {
        bot.events
            .iter()
            .rposition(|e| matches!(e, Event::Known(k) if test(k)))
    };
    let base = |i: usize, kind: &str, call_id: &str, what: String| Waiting {
        agent: bot.agent.to_owned(),
        name: bot.name.to_owned(),
        conversation: bot.conversation.to_owned(),
        seq: seq(i),
        since_ms: at(i),
        kind: kind.to_owned(),
        call_id: call_id.to_owned(),
        what,
        answer: None,
        options: Vec::new(),
    };
    let mut open = Vec::new();
    for call in &Transcript::fold(bot.events.iter()).awaiting {
        let found =
            find(&|k| matches!(k, Known::ApprovalRequested { call_id, .. } if call_id == call));
        if let Some(i) = found
            && let Event::Known(known) = &bot.events[i]
        {
            let what = sentence(known).unwrap_or_else(|| "Wants your yes.".to_owned());
            open.push(Waiting {
                answer: Some("approval".to_owned()),
                ..base(i, "approval", call, what)
            });
        }
    }
    for card in views(bot.events.iter()) {
        if !matches!(card.standing, Standing::Waiting | Standing::Deferred) {
            continue;
        }
        let found = find(
            &|k| matches!(k, Known::QuestionAsked { call_id, .. } if call_id == &card.call_id),
        );
        let Some(i) = found else { continue };
        let prompt = card
            .questions
            .iter()
            .map(|q| one_line(&q.prompt))
            .collect::<Vec<_>>()
            .join(" ");
        let mut waiting = base(i, "question", &card.call_id, format!("Asks: {prompt}"));
        if let [only] = card.questions.as_slice() {
            match &only.kind {
                Kind::Choice { options, .. } if options.len() <= 4 => {
                    waiting.answer = Some("choice".to_owned());
                    waiting.options = options.iter().map(|o| one_line(&o.label)).collect();
                }
                Kind::Confirm {} => waiting.answer = Some("confirm".to_owned()),
                _ => {}
            }
        }
        open.push(waiting);
    }
    open
}

/// The brief as plain text, the same in a notification, the app and a message.
pub fn text(brief: &Brief, time: &dyn Fn(i64) -> String) -> String {
    let mut out = vec![format!("Since {}:", time(brief.from_ms))];
    let section = |out: &mut Vec<String>, title: &str, lines: Vec<String>| {
        if lines.is_empty() {
            return;
        }
        out.push(String::new());
        out.push(title.to_owned());
        out.extend(lines.into_iter().map(|l| format!("- {l}")));
    };
    let mut done: Vec<String> = brief
        .finished
        .iter()
        .map(|f| format!("{}: {}", f.name, f.text))
        .collect();
    if brief.more_finished > 0 {
        done.push(format!("and {} more", brief.more_finished));
    }
    if done.is_empty() {
        done.push("Nothing finished.".to_owned());
    }
    section(&mut out, "Finished:", done);
    section(
        &mut out,
        "Waiting on you:",
        brief
            .waiting
            .iter()
            .map(|w| format!("{}: {}", w.name, w.what))
            .collect(),
    );
    section(
        &mut out,
        "While you were away:",
        brief
            .away
            .iter()
            .map(|a| format!("{}: {}", a.name, a.text))
            .collect(),
    );
    section(
        &mut out,
        "Today:",
        brief
            .today
            .iter()
            .map(|p| format!("{}: {} at {}", p.name, p.routine, time(p.at_ms)))
            .collect(),
    );
    out.push(String::new());
    out.push(spend_line(&brief.spend));
    out.join("\n")
}

fn spend_line(spend: &Spend) -> String {
    if spend.total_micros == 0 {
        return "Spent nothing.".to_owned();
    }
    let bots: Vec<String> = spend
        .bots
        .iter()
        .take(5)
        .map(|b| format!("{} {}", b.name, dollars(b.micros)))
        .collect();
    if bots.is_empty() {
        format!("Spent {}.", dollars(spend.total_micros))
    } else {
        format!(
            "Spent {} ({}).",
            dollars(spend.total_micros),
            bots.join(", ")
        )
    }
}

/// The notification's one line: "2 finished, 1 waiting on you, 3 routines today".
pub fn headline(brief: &Brief) -> String {
    let finished = brief.finished.len() + usize::try_from(brief.more_finished).unwrap_or(0);
    let mut parts = vec![format!("{finished} finished")];
    if !brief.waiting.is_empty() {
        parts.push(format!("{} waiting on you", brief.waiting.len()));
    }
    match brief.today.len() {
        0 => {}
        1 => parts.push("1 routine today".to_owned()),
        n => parts.push(format!("{n} routines today")),
    }
    let mut line = parts.join(", ");
    if brief.spend.total_micros > 0 {
        line.push_str(&format!(", {} spent", dollars(brief.spend.total_micros)));
    }
    line
}
