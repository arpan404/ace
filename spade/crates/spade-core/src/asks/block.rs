//! The short block that tells the model the person's asks (ADR 0215 §2): standing instructions,
//! open asks newest first, then new messages not yet sorted. Built from the ledger and stored
//! where it is read, so every prompt is a prefix of the next.

use crate::event::{Event, Known};

use super::{Ask, Ledger, State};

/// The most asks the block lists; the rest are counted.
pub const SHOWN: usize = 12;

/// The block for `ledger`, or `None` when nothing stands, is open or is new.
pub fn text(ledger: &Ledger) -> Option<String> {
    let new: Vec<&Ask> = ledger.asks.iter().rev().filter(|a| !a.sorted).collect();
    let kept: Vec<&Ask> = ledger.asks.iter().rev().filter(|a| a.sorted).collect();
    if ledger.standing.is_empty() && new.is_empty() && kept.is_empty() {
        return None;
    }
    let mut out = String::from("<asks from=\"spade\">\nTracked asks (not new messages):");
    if !ledger.standing.is_empty() {
        out.push_str("\nStanding:");
        for standing in &ledger.standing {
            out.push_str(&format!(
                "\n- {} (from {}): {}",
                standing.id,
                quoted(&standing.from),
                quoted(&standing.words)
            ));
        }
    }
    // New messages are listed first, since they need sorting; open asks fill what is left.
    let new_shown = new.len().min(SHOWN);
    let kept_shown = kept.len().min(SHOWN - new_shown);
    if kept_shown > 0 {
        out.push_str("\nOpen (newest first):");
        for ask in &kept[..kept_shown] {
            out.push_str(&format!("\n- {}", row(ask)));
        }
    }
    if new_shown > 0 {
        out.push_str("\nUnsorted:");
        for ask in &new[..new_shown] {
            out.push_str(&format!("\n- {}", row(ask)));
        }
        if new_shown > 1 {
            out.push_str("\nSeveral are new: answer each in its own <msg reply=\"<id>\">.");
        }
    }
    let more = (new.len() - new_shown + kept.len() - kept_shown) as u32 + ledger.earlier;
    if more > 0 {
        out.push_str(&format!("\n+{more} older (history_search)."));
    }
    if new_shown > 0 || kept_shown > 0 {
        out.push_str("\nUpdate with asks (give a reason).");
    }
    out.push_str("\n</asks>");
    Some(out)
}

/// The block to store before the next call: `text(ledger)` when it stands and differs from the
/// latest stored block since the last compaction, so nothing is stored on every step. The block
/// is stored where it is read, so the prompt the call gets is a prefix of the next one.
pub fn due(events: &[Event], ledger: &Ledger) -> Option<String> {
    let text = text(ledger)?;
    for event in events.iter().rev() {
        match event {
            // Nothing before a compaction reads: its earlier blocks were cut with it.
            Event::Known(Known::ContextCompacted { .. }) => break,
            Event::Known(Known::AsksShown { text: shown }) => {
                return (shown != &text).then_some(text);
            }
            _ => {}
        }
    }
    Some(text)
}

fn row(ask: &Ask) -> String {
    let mut head = ask.id.clone();
    if ask.steer {
        head.push_str(", steer");
    }
    if let State::Waiting(on) = ask.state {
        head.push_str(&format!(", waiting on {}", on.words()));
    }
    format!("{head}: {}", quoted(&ask.words))
}

/// Words on one line as a JSON string with `<` escaped, so they can't close the block.
pub(super) fn quoted(text: &str) -> String {
    serde_json::to_string(text)
        .unwrap_or_default()
        .replace('<', "\\u003c")
}
