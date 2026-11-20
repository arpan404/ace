//! `notify {title, body}` (ADR 0200 §4.2, `spade.v1` module `notify`): a proactive notice from a
//! bot to the person. It is a `notice` under ADR 0195: proactive, so do not disturb, quiet hours
//! and the interruption budget hold it, and the bot's own reach switch silences it. On top, each
//! bot has its own rate: past [`PER_HOUR`] in the last hour a notice waits for the brief, past
//! [`PER_DAY`] in the last day it is refused, so a bot can't spam the person or flood the brief.
//! Its words are the bot's, shown as untrusted text. Pure: the engine passes the clock and what
//! the bot already sent.

use serde_json::Value;

use super::{Decision, Reach, Why};

/// The tool's name.
pub const NOTIFY: &str = "notify";
/// The longest title and body, in characters.
pub const TITLE_CHARS: usize = 80;
pub const BODY_CHARS: usize = 600;
/// A bot's notices in the last hour past which the next waits for the brief.
pub const PER_HOUR: usize = 3;
/// A bot's notices in the last day past which the next is refused.
pub const PER_DAY: usize = 12;

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// A checked `notify` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub title: String,
    pub body: String,
}

impl Notice {
    /// The one line ace's alert and the brief show: the title, then the body.
    pub fn text(&self) -> String {
        if self.body.is_empty() {
            self.title.clone()
        } else {
            format!("{}: {}", self.title, self.body)
        }
    }
}

/// `{title, body}` and nothing else, each plain text within its length. Control characters are
/// dropped and runs of space folded, so the notice is the words the person reads, nothing more.
pub fn parse(arguments: &Value) -> Result<Notice, String> {
    let Some(fields) = arguments.as_object() else {
        return Err("Give `title` and `body`.".to_owned());
    };
    if let Some(other) = fields
        .keys()
        .find(|k| !["title", "body"].contains(&k.as_str()))
    {
        return Err(format!(
            "Refused: `{other}` isn't taken. A notice is a `title` and a `body`, and Spade decides \
             when it reaches the person."
        ));
    }
    let read = |key: &str| {
        fields
            .get(key)
            .and_then(Value::as_str)
            .map(plain)
            .unwrap_or_default()
    };
    let title = read("title");
    let body = read("body");
    if title.is_empty() {
        return Err("Give `title`: a few words the person reads first.".to_owned());
    }
    if title.chars().count() > TITLE_CHARS {
        return Err(format!("Keep `title` under {TITLE_CHARS} characters."));
    }
    if body.chars().count() > BODY_CHARS {
        return Err(format!("Keep `body` under {BODY_CHARS} characters."));
    }
    Ok(Notice { title, body })
}

/// Text with control characters dropped and whitespace folded into single spaces.
fn plain(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Where a bot stands against its own rate, from when it sent each notice (any order).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rate {
    /// Room for one more now.
    Room,
    /// Its hour is full: this one waits for the brief.
    Hour,
    /// Its day is full: this one is refused.
    Day,
}

pub fn rate(sent: &[i64], now_ms: i64) -> Rate {
    let within = |period: i64| {
        sent.iter()
            .filter(|at| **at > now_ms - period && **at <= now_ms)
            .count()
    };
    if within(DAY_MS) >= PER_DAY {
        Rate::Day
    } else if within(HOUR_MS) >= PER_HOUR {
        Rate::Hour
    } else {
        Rate::Room
    }
}

/// The sends still worth keeping: those inside the longest period.
pub fn keep(sent: &mut Vec<i64>, now_ms: i64) {
    sent.retain(|at| *at > now_ms - DAY_MS);
}

/// ADR 0195's decision for a notice, held when the bot's hour is full and it would have gone out
/// now. Off, a bot switched off, do not disturb and quiet hours keep their own reasons.
pub fn limit(decided: Decision, rate: Rate) -> Decision {
    if decided.reach == Reach::Now && rate == Rate::Hour {
        return Decision {
            reach: Reach::Held,
            why: Some(Why::Rate),
            counts: false,
        };
    }
    decided
}

/// What the bot reads once its notice was decided.
pub fn result(decided: Decision) -> String {
    match (decided.reach, decided.why) {
        (Reach::Now, _) => "Sent to the person.".to_owned(),
        (Reach::Held, Some(Why::Dnd)) => {
            "Held: the person has do not disturb on. It goes into their next brief.".to_owned()
        }
        (Reach::Held, Some(Why::Quiet)) => {
            "Held: it's the person's quiet hours. It goes into their next brief.".to_owned()
        }
        (Reach::Held, Some(Why::Rate)) => format!(
            "Held: you've sent {PER_HOUR} notices this hour. It goes into the person's next \
             brief; send fewer, and put more in each."
        ),
        (Reach::Held, _) => {
            "Held: the person has had enough interruptions for now. It goes into their next brief."
                .to_owned()
        }
        (_, Some(Why::BotOff)) => {
            "Not sent: the person turned off notifications from you. Say it in your reply instead."
                .to_owned()
        }
        (_, _) => {
            "Not sent: the person turned off Spade's notifications. Say it in your reply instead."
                .to_owned()
        }
    }
}

/// What the bot reads when its day is full.
pub fn refused_for_the_day() -> String {
    format!(
        "Not sent: you've sent {PER_DAY} notices today, the most a bot sends. Say it in your reply \
         instead."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_notice_is_a_plain_title_and_body() {
        let notice =
            parse(&json!({ "title": " Fare\u{7}  dropped ", "body": "LIS to\nNRT: €612" }));
        assert_eq!(
            notice,
            Ok(Notice {
                title: "Fare dropped".into(),
                body: "LIS to NRT: €612".into()
            })
        );
        assert_eq!(
            parse(&json!({ "title": "Only a title" })).map(|n| n.text()),
            Ok("Only a title".to_owned())
        );
        for refused in [
            json!({ "body": "no title" }),
            json!({ "title": "   " }),
            json!({ "title": "t", "body": "b", "when": "now" }),
            json!({ "title": "t", "urgent": true }),
            json!({ "title": "x".repeat(TITLE_CHARS + 1) }),
            json!({ "title": "t", "body": "x".repeat(BODY_CHARS + 1) }),
            json!("hello"),
        ] {
            assert!(parse(&refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn a_bots_rate_holds_past_its_hour_and_refuses_past_its_day() {
        let now = 10 * DAY_MS;
        assert_eq!(rate(&[], now), Rate::Room);
        let hour: Vec<i64> = (0..PER_HOUR as i64).map(|i| now - i * 60_000).collect();
        assert_eq!(rate(&hour, now), Rate::Hour);
        // Sent over an hour ago: the hour has room again.
        let earlier: Vec<i64> = hour.iter().map(|at| at - HOUR_MS).collect();
        assert_eq!(rate(&earlier, now), Rate::Room);
        let day: Vec<i64> = (0..PER_DAY as i64).map(|i| now - 2 * HOUR_MS - i).collect();
        assert_eq!(rate(&day, now), Rate::Day);
        let mut old = vec![now - DAY_MS - 1, now - 5];
        keep(&mut old, now);
        assert_eq!(old, vec![now - 5]);
    }

    #[test]
    fn a_full_hour_holds_only_what_would_go_out_now() {
        let now = Decision {
            reach: Reach::Now,
            why: None,
            counts: true,
        };
        let held = limit(now, Rate::Hour);
        assert_eq!(
            (held.reach, held.why, held.counts),
            (Reach::Held, Some(Why::Rate), false)
        );
        assert_eq!(limit(now, Rate::Room), now);
        let quiet = Decision {
            reach: Reach::Held,
            why: Some(Why::Quiet),
            counts: false,
        };
        assert_eq!(limit(quiet, Rate::Hour), quiet);
        assert!(result(quiet).contains("quiet hours"));
        assert!(result(held).contains("next brief"));
    }
}
