//! A digest as plain text (ADR 0165): no Markdown, so it reads the same in a notification, the
//! app and a message. Times are written by the caller's clock and zone.

use std::fmt::Write as _;

use super::Digest;
use crate::goal::view::State;
use crate::oversight::dollars;

/// The digest as text. `time` writes a time for the person (`14:05`, `Mon 14:05`).
pub fn text(digest: &Digest, time: &dyn Fn(i64) -> String) -> String {
    let mut out = String::new();
    write_digest(&mut out, digest, time, "");
    out.trim_end().to_owned()
}

/// The first line alone, for a notification.
pub fn headline(digest: &Digest, time: &dyn Fn(i64) -> String) -> String {
    text(digest, time)
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned()
}

fn state_words(state: State) -> &'static str {
    match state {
        State::None => "No goal open",
        State::Working => "Working",
        State::Checking => "Checking the work",
        State::NotYet => "The check said not yet",
        State::Unchecked => "Says done, not checked",
        State::Done => "Done, checked",
    }
}

fn write_digest(out: &mut String, d: &Digest, time: &dyn Fn(i64) -> String, pad: &str) {
    let line = |out: &mut String, text: &str| {
        let _ = writeln!(out, "{pad}{text}");
    };
    if d.quiet {
        line(
            out,
            &format!("{}: nothing new since {}.", d.name, time(d.from_ms)),
        );
        return;
    }
    line(
        out,
        &format!("{}: from {} to {}", d.name, time(d.from_ms), time(d.to_ms)),
    );
    if let Some(p) = &d.progress {
        line(
            out,
            &format!(
                "Goal: {}. {} of {} closed, {} verified. {}.",
                p.title,
                p.items_closed,
                p.items_total,
                p.items_verified,
                state_words(p.state)
            ),
        );
        if p.closed_in_window > 0 {
            line(
                out,
                &format!(
                    "In this time: {} closed, {} of them verified.",
                    p.closed_in_window, p.verified_in_window
                ),
            );
        }
    }
    if d.activity.replies > 0 || d.activity.calls > 0 {
        let count = |n: u32, one: &str, many: &str| match n {
            1 => format!("1 {one}"),
            n => format!("{n} {many}"),
        };
        line(
            out,
            &format!(
                "{}, {}.",
                count(d.activity.replies, "reply", "replies"),
                count(d.activity.calls, "tool call", "tool calls")
            ),
        );
    }
    if !d.changed.is_empty() {
        line(out, "What changed:");
        for change in &d.changed {
            line(out, &format!("- {}", change.text));
        }
        if d.more_changed > 0 {
            line(out, &format!("- and {} more", d.more_changed));
        }
    }
    if !d.away.is_empty() {
        line(out, "While you were away:");
        for away in &d.away {
            line(out, &format!("- {away}"));
        }
    }
    if !d.decisions.is_empty() {
        line(out, "Decided for you:");
        for decided in &d.decisions {
            let decision = &decided.decision;
            let mut text = format!("- {}. Why: {}", decision.choice, decision.reason);
            if !decision.options.is_empty() {
                let _ = write!(text, " Set aside: {}.", decision.options.join(", "));
            }
            line(out, &text);
        }
    }
    let mut spend = format!("Spent {}", dollars(d.spend.total_micros));
    let roles: Vec<String> = d
        .spend
        .by_role
        .iter()
        .filter(|(_, micros)| **micros > 0)
        .map(|(role, micros)| format!("{role} {}", dollars(*micros)))
        .collect();
    if !roles.is_empty() {
        let _ = write!(spend, " ({})", roles.join(", "));
    }
    if !d.workers.is_empty() {
        let _ = write!(
            spend,
            ", {} with its workers",
            dollars(d.subtree_spend_micros)
        );
    }
    spend.push('.');
    line(out, &spend);
    if !d.waiting.is_empty() {
        line(out, "Waiting on you:");
        for waiting in &d.waiting {
            line(
                out,
                &format!(
                    "- {} (since {}, {})",
                    waiting.what,
                    time(waiting.since_ms),
                    waiting.level.name()
                ),
            );
        }
    }
    if !d.blocked.is_empty() {
        line(out, "Blocked:");
        for blocked in &d.blocked {
            line(
                out,
                &format!("- {}: {}: {}", blocked.item, blocked.text, blocked.reason),
            );
        }
    }
    if !d.next.is_empty() {
        line(out, "Next:");
        for next in &d.next {
            line(out, &format!("- {next}"));
        }
    }
    if !d.workers.is_empty() {
        line(out, "Workers:");
        let inner = format!("{pad}  ");
        for worker in &d.workers {
            write_digest(out, worker, time, &inner);
        }
    }
}
