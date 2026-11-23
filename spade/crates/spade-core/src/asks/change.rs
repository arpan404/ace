//! An `asks` call, checked against the ledger: what it changes, or why not. The engine stores
//! the accepted changes as `asks_updated`; the ledger's fold reads only that.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Ledger, MOST_STANDING, On, State, WORDS_CHARS, cut};

/// The most parts one ask splits into.
const MOST_PARTS: usize = 8;
/// The most of a reason kept, for the step rows.
const REASON_CHARS: usize = 200;

/// One accepted change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Change {
    /// Sorted as one open ask, or opened again.
    Open { ask: String },
    Split { ask: String, into: Vec<String> },
    Done { ask: String, reason: String },
    Dropped { ask: String, reason: String },
    Chat { ask: String, reason: String },
    Changed { ask: String, words: String, reason: String },
    Waiting { ask: String, on: On, reason: String },
    Standing { id: String, from: String, words: String },
    Lift { standing: String, reason: String },
}

/// What the call changed and what its result says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accepted {
    pub changes: Vec<Change>,
    pub result: String,
}

#[derive(Deserialize)]
struct Args {
    changes: Vec<Asked>,
}

#[derive(Deserialize)]
struct Asked {
    op: String,
    #[serde(default)]
    ask: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    into: Option<Vec<String>>,
    #[serde(default)]
    on: Option<String>,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    standing: Option<String>,
}

/// The call's changes, each checked against the ledger as the earlier ones leave it. `trusted`
/// is false in a reply that read untrusted output: then only states change, and nothing the bot
/// writes (new wording, parts, a standing instruction) is taken, since it could come from that
/// output.
pub fn decide(ledger: &Ledger, arguments: &Value, trusted: bool) -> Result<Accepted, String> {
    let args: Args = serde_json::from_value(arguments.clone())
        .map_err(|e| format!("asks takes {{\"changes\": [...]}}: {e}"))?;
    if args.changes.is_empty() {
        return Err("asks needs at least one change.".to_owned());
    }
    let mut after = ledger.clone();
    let mut changes = Vec::new();
    let mut said = Vec::new();
    for asked in args.changes {
        let one = accept(&after, ledger, asked, trusted)?;
        said.push(line(&one));
        after.apply(&one);
        changes.push(one);
    }
    let open = after.open_asks().count();
    let mut result = said.join("\n");
    result.push_str(&match open {
        0 => "\nNo asks are open.".to_owned(),
        1 => "\n1 ask is still open.".to_owned(),
        n => format!("\n{n} asks are still open."),
    });
    if changes.iter().any(|c| matches!(c, Change::Standing { .. })) {
        result.push_str(
            "\nIf it changes your job for good, offer to rewrite your task with task_update, or \
             to save it with memory_save; don't do either without asking.",
        );
    }
    Ok(Accepted { changes, result })
}

fn accept(ledger: &Ledger, before: &Ledger, asked: Asked, trusted: bool) -> Result<Change, String> {
    let reason = asked
        .reason
        .as_deref()
        .map(|r| cut(r, REASON_CHARS))
        .unwrap_or_default();
    let needs_reason = |op: &str| -> Result<String, String> {
        if reason.is_empty() {
            Err(format!("{op} needs a short reason."))
        } else {
            Ok(reason.clone())
        }
    };
    let untrusted = |op: &str| -> Result<(), String> {
        if trusted {
            Ok(())
        } else {
            Err(format!(
                "{op} adds your own words to the asks, and this reply read untrusted content \
                 (a page, an email, a tool's output), so Spade can't take them now. Change only \
                 states (open, done, dropped, chat, waiting) here; add it in your next reply."
            ))
        }
    };
    let op = asked.op.as_str();
    if op == "standing" {
        untrusted(op)?;
        let from = asked
            .from
            .ok_or("standing needs from: the id of the person's message it came from.")?;
        if !from_person(before, &from) && !from_person(ledger, &from) {
            return Err(format!("{from} is not a message from the person."));
        }
        let words = text_of(asked.text, op)?;
        if ledger.standing.len() >= MOST_STANDING {
            return Err(format!(
                "There are already {MOST_STANDING} standing instructions; lift one first."
            ));
        }
        return Ok(Change::Standing {
            id: format!("s{}", ledger.standing_made + 1),
            from,
            words,
        });
    }
    if op == "lift" {
        let standing = asked.standing.ok_or("lift needs standing: its id (s1).")?;
        if !ledger.standing.iter().any(|s| s.id == standing) {
            return Err(format!("There is no standing instruction {standing}."));
        }
        return Ok(Change::Lift {
            standing,
            reason: needs_reason(op)?,
        });
    }
    let ask = asked
        .ask
        .ok_or_else(|| format!("{op} needs ask: the ask's id (m12)."))?;
    let Some(found) = ledger.ask(&ask) else {
        return Err(format!(
            "There is no open ask {ask}; it may be closed already, or its id is different."
        ));
    };
    Ok(match op {
        "open" => Change::Open { ask },
        "done" => Change::Done {
            ask,
            reason: needs_reason(op)?,
        },
        "dropped" => Change::Dropped {
            ask,
            reason: needs_reason(op)?,
        },
        "chat" => Change::Chat { ask, reason },
        "waiting" => {
            let on = match asked.on.as_deref() {
                Some("person") => On::Person,
                Some("job") => On::Job,
                Some("time") => On::Time,
                _ => return Err("waiting needs on: person, job or time.".to_owned()),
            };
            Change::Waiting {
                ask,
                on,
                reason: needs_reason(op)?,
            }
        }
        "changed" => {
            untrusted(op)?;
            Change::Changed {
                ask,
                words: text_of(asked.text, op)?,
                reason: needs_reason(op)?,
            }
        }
        "split" => {
            untrusted(op)?;
            let into: Vec<String> = asked
                .into
                .unwrap_or_default()
                .iter()
                .map(|p| cut(p, WORDS_CHARS))
                .filter(|p| !p.is_empty())
                .collect();
            if into.len() < 2 || into.len() > MOST_PARTS {
                return Err(format!("split needs into: 2 to {MOST_PARTS} parts."));
            }
            if found.state != State::Open {
                return Err(format!("{ask} is waiting; open it before splitting it."));
            }
            Change::Split { ask, into }
        }
        other => {
            return Err(format!(
                "Unknown op {other}: use open, split, done, dropped, changed, waiting, chat, \
                 standing or lift."
            ));
        }
    })
}

fn text_of(text: Option<String>, op: &str) -> Result<String, String> {
    let text = cut(text.as_deref().unwrap_or_default(), WORDS_CHARS);
    if text.is_empty() {
        Err(format!("{op} needs text."))
    } else {
        Ok(text)
    }
}

/// Whether `id` names one of the person's messages still in the ledger (or a part of one): only
/// those can carry a standing instruction, so record it before closing its ask.
fn from_person(ledger: &Ledger, id: &str) -> bool {
    let root = id.split('.').next().unwrap_or(id);
    ledger
        .asks
        .iter()
        .any(|a| a.id.split('.').next() == Some(root))
}

/// One line of the call's result and of its step row.
pub fn line(one: &Change) -> String {
    match one {
        Change::Open { ask } => format!("{ask}: open."),
        Change::Split { ask, into } => format!("{ask}: split into {} asks.", into.len()),
        Change::Done { ask, reason } => format!("{ask}: done ({reason})."),
        Change::Dropped { ask, reason } => format!("{ask}: dropped ({reason})."),
        Change::Chat { ask, .. } => format!("{ask}: nothing to do."),
        Change::Changed { ask, .. } => format!("{ask}: reworded."),
        Change::Waiting { ask, on, .. } => format!("{ask}: waiting on {}.", on.words()),
        Change::Standing { id, from, .. } => format!("{id}: standing, from {from}."),
        Change::Lift { standing, .. } => format!("{standing}: lifted."),
    }
}
