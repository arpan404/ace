//! The short block every model call ends with (ADR 0215 §2): standing instructions, open asks
//! newest first, then new messages not yet sorted. Rebuilt from the ledger for each call and
//! never stored, so it never changes a byte of the prompt before it.

use spade_models::{Message, Prompt};

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

/// `prompt` with the block as its last message, after everything stored: every earlier byte is
/// what the previous call sent, so the provider's cached prefix still holds.
pub fn appended(mut prompt: Prompt, ledger: &Ledger) -> Prompt {
    if let Some(text) = text(ledger) {
        prompt.messages.push(Message::Person {
            text,
            images: Vec::new(),
        });
    }
    prompt
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
