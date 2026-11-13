//! What a shell command reaches, decided without a model (ADR 0144): the commands a reviewer must
//! never approve on the person's behalf (sending over the network, mail, publishing, changing
//! servers, writing or deleting outside the bot's folder, driving other apps, admin rights,
//! payments), anything it can't read for sure, and the code it runs from files, which the
//! reviewer is shown. Every simple command is looked at: across pipes, `;`, `&&`, `||`, `$(...)`,
//! `sh -c` strings and the wrappers that run another command (`env`, `xargs`, `find -exec`,
//! `sudo`…). It is a best-effort layer in front of the reviewer, not containment (that is an OS
//! sandbox's job): what it can't follow it sends to the person as unclear.

mod effects;
mod options;
mod parse;
mod paths;
mod scripts;

pub use paths::{Lexical, Place, Unseen, normalized};
pub use scripts::LONGEST_SCRIPT;

use super::Sensitive;
use super::secrets::command_reads;
use parse::{Simple, parse};

/// What a command needs, beyond the reviewer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finding {
    /// It reads sign-ins or credentials: never run.
    Credentials,
    /// The person decides.
    Sensitive(Sensitive),
}

/// A file a command runs, as the reviewer is shown it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shown {
    /// As the command names it (`./build.sh`, `Makefile`, `package.json (scripts)`).
    pub path: String,
    pub content: String,
}

/// What a command needs, and the code it runs from files.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Assessment {
    /// `None` when nothing here stands out (the reviewer still judges it).
    pub finding: Option<Finding>,
    /// What the reviewer must read besides the command, in the order it runs.
    pub shown: Vec<Shown>,
}

/// What `command` needs, run from `place`.
pub fn assess(command: &str, place: &dyn Place) -> Assessment {
    let mut shown = Vec::new();
    let finding = assess_at(command, place, 0, &mut shown);
    Assessment { finding, shown }
}

/// [`assess`] for a command `depth` scripts deep, adding what it runs to `shown`.
fn assess_at(
    command: &str,
    place: &dyn Place,
    depth: usize,
    shown: &mut Vec<Shown>,
) -> Option<Finding> {
    let Ok(commands) = parse(command, 0) else {
        return Some(Finding::Sensitive(Sensitive::Unclear));
    };
    if commands.iter().any(|c| command_reads(&with_targets(c))) {
        return Some(Finding::Credentials);
    }
    let mut runs = Vec::new();
    for command in &commands {
        let effect = effects::classify(command, place);
        if let Some(kind) = effect.sensitive {
            return Some(Finding::Sensitive(kind));
        }
        runs.extend(effect.runs);
    }
    scripts::show(&runs, place, depth, shown)
}

/// Every simple command in `text`, as words (wrappers taken off, output targets after them);
/// `None` when it can't be read.
pub fn simple_commands(text: &str) -> Option<Vec<Vec<String>>> {
    parse(text, 0)
        .ok()
        .map(|commands| commands.iter().map(with_targets).collect())
}

fn with_targets(simple: &Simple) -> Vec<String> {
    simple
        .words
        .iter()
        .chain(&simple.writes_to)
        .chain(&simple.reads_from)
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests;
