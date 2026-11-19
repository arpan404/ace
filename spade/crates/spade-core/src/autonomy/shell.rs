//! What a shell command reaches, decided without a model (ADR 0144): the commands a reviewer must
//! never approve on the person's behalf (sending over the network, mail, publishing, changing
//! servers, writing or deleting outside the bot's folder, driving other apps, admin rights,
//! payments), anything it can't read for sure, and the code it runs from files, which the
//! reviewer is shown. Every simple command is looked at: across pipes, `;`, `&&`, `||`, `$(...)`,
//! `sh -c` strings and the wrappers that run another command (`env`, `xargs`, `find -exec`,
//! `sudo`…). It is a best-effort layer in front of the reviewer, not containment (that is an OS
//! sandbox's job): what it can't follow it sends to the person as unclear.

mod apple;
mod effects;
mod make;
mod options;
mod parse;
mod paths;
mod scripts;

pub use effects::system_program;
pub use parse::Simple;
pub use paths::{Lexical, Place, Program, Unseen, normalized};
pub use scripts::LONGEST_SCRIPT;

use std::path::PathBuf;

use super::secrets::command_reads;
use super::{ConfigTools, Sensitive};
use parse::parse;

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
    /// Something it runs couldn't be read whole, so `shown` isn't all of it.
    pub incomplete: bool,
    /// Programs it runs from outside the system's folders and the bot's, as `PATH` finds them.
    pub programs: Vec<PathBuf>,
    /// The tools it runs whose configuration could run a program it never names, by the real
    /// folder each runs in: that folder's configuration is the one to inspect.
    pub config: Vec<(PathBuf, ConfigTools)>,
}

/// What `command` needs, run from `place`. Refusing for credentials comes before any other
/// finding: what reads them anywhere in the command, a script it runs or a nested command is
/// refused, whatever else it does.
pub fn assess(command: &str, place: &dyn Place) -> Assessment {
    let mut walk = Walk::default();
    assess_at(command, place, 0, &mut walk);
    let finding = if walk.credentials {
        Some(Finding::Credentials)
    } else {
        walk.sensitive.map(Finding::Sensitive)
    };
    Assessment {
        finding,
        shown: walk.shown,
        incomplete: walk.incomplete,
        programs: walk.programs,
        config: walk.config,
    }
}

/// What a command and everything it runs came to, gathered as it is read: nothing stops the
/// walk early, so a credential read is found however late it comes.
#[derive(Default)]
pub(super) struct Walk {
    pub shown: Vec<Shown>,
    pub credentials: bool,
    /// The first kind found of the highest rank: a payment or a send as the person (theirs
    /// alone to decide) over any other, and a plain kind (publishing, the network…) over
    /// "unclear" or "can't show", since it names what the command does.
    pub sensitive: Option<Sensitive>,
    /// Real paths of the files that run.
    pub ran: Vec<PathBuf>,
    /// What reading this command has used of its [`Budget`].
    pub spent: Budget,
    /// Something it runs couldn't be read whole: a script over the read limit, outside the
    /// folder or unreadable, or the reading's budget spent first. What was read can't stand for
    /// what will run.
    pub incomplete: bool,
    /// Programs it runs from outside the system's folders and the bot's (`Program::At`).
    pub programs: Vec<PathBuf>,
    /// The tools it runs that read configuration, by the real folder each runs in.
    pub config: Vec<(PathBuf, ConfigTools)>,
}

/// What one classification may read, all told: files, their bytes, and command text checked
/// (scripts, recipes, nested commands). Checked before each read and each command; once spent
/// the rest is unclear, and what was found so far (a credential read) still holds.
#[derive(Debug, Default, Clone, Copy)]
pub(super) struct Budget {
    files: usize,
    bytes: usize,
    text: usize,
}

const MOST_FILES: usize = 64;
const MOST_BYTES: usize = 2 * 1024 * 1024;
const MOST_TEXT: usize = 2 * 1024 * 1024;

impl Budget {
    /// Whether another file may be read.
    pub(super) fn may_read(&self) -> bool {
        self.files < MOST_FILES && self.bytes < MOST_BYTES
    }

    /// Counts a file read; whether it was within the budget.
    pub(super) fn read(&mut self, bytes: usize) -> bool {
        self.files += 1;
        self.bytes += bytes;
        self.files <= MOST_FILES && self.bytes <= MOST_BYTES
    }

    /// Counts command text about to be checked; whether it is within the budget.
    fn check(&mut self, text: usize) -> bool {
        self.text += text;
        self.text <= MOST_TEXT
    }
}

impl Walk {
    pub(super) fn kind(&mut self, kind: Sensitive) {
        // Spade couldn't read or resolve all of what runs: a script it can't show, or anything
        // unclear (the command doesn't parse, a folder or program it can't place, a command name
        // built at run time, a script piped in or written and then run).
        if matches!(kind, Sensitive::UnseenScript | Sensitive::Unclear) {
            self.incomplete = true;
        }
        let rank = |k: Sensitive| match k {
            _ if k.persons().is_some() => 2,
            Sensitive::Unclear | Sensitive::UnseenScript => 0,
            _ => 1,
        };
        match self.sensitive {
            Some(found) if rank(found) >= rank(kind) => {}
            _ => self.sensitive = Some(kind),
        }
    }
}

/// [`assess`] for a command `depth` scripts deep, from `place`.
fn assess_at(command: &str, place: &dyn Place, depth: usize, walk: &mut Walk) {
    if !walk.spent.check(command.len()) {
        walk.incomplete = true;
        // Still refused if it plainly names a credential place.
        if super::secrets::names_place(command) {
            walk.credentials = true;
        }
        walk.kind(Sensitive::Unclear);
        return;
    }
    // Bash's network files, in any redirect or argument.
    if command.contains("/dev/tcp/") || command.contains("/dev/udp/") {
        walk.kind(Sensitive::Network);
    }
    let Ok(commands) = parse(command, 0) else {
        walk.kind(Sensitive::Unclear);
        return;
    };
    // It sets its own `PATH`: which program a bare name runs can't be told from the one it
    // starts with.
    if sets_path(command) {
        walk.kind(Sensitive::Unclear);
    }
    let ran_before = walk.ran.len();
    let mut wrote: Vec<PathBuf> = Vec::new();
    let mut rewrites = false;
    // Folders `cd` moved to, with the subshell depth each holds in.
    let mut folders: Vec<(usize, String)> = Vec::new();
    for simple in &commands {
        while folders
            .last()
            .is_some_and(|(group, _)| simple.group < *group)
        {
            folders.pop();
        }
        let dir = match (folders.last(), &simple.dir) {
            (Some((_, base)), Some(dir)) if !dir.starts_with('/') => Some(format!("{base}/{dir}")),
            (_, Some(dir)) => Some(dir.clone()),
            (Some((_, base)), None) => Some(base.clone()),
            (None, None) => None,
        };
        let here = match &dir {
            Some(dir) => match paths::moved(place, dir) {
                Some(here) => Some(here),
                None => {
                    walk.kind(Sensitive::Unclear);
                    continue;
                }
            },
            None => None,
        };
        let at: &dyn Place = match &here {
            Some(here) => here,
            None => place,
        };
        let program = simple
            .words
            .first()
            .map(|w| super::secrets::basename(w))
            .unwrap_or("");
        if matches!(program, "cd" | "pushd" | "popd" | "chdir") {
            let target = simple.words.get(1).filter(|t| !t.starts_with('-'));
            match target.and_then(|t| paths::moved(at, t)) {
                Some(moved) if program != "popd" => {
                    let real = moved.resolve(".").map(|r| r.to_string_lossy().into_owned());
                    match real {
                        Some(real) => folders.push((simple.group, real)),
                        None => walk.kind(Sensitive::Unclear),
                    }
                }
                // `cd` alone, `cd -`, `cd ~`, `cd $X`, `popd`: Spade can't say where it goes.
                _ => walk.kind(Sensitive::Unclear),
            }
            continue;
        }
        if command_reads(&with_targets(simple)) {
            walk.credentials = true;
        }
        let effect = effects::classify(simple, at);
        if effect.writes_outside {
            walk.kind(Sensitive::WriteOutside);
        }
        if let Some(kind) = effect.sensitive {
            walk.kind(kind);
        }
        // What runs is found whatever the command does: kept apart from what it does, so no
        // effect (a write outside, a program the rules don't know) hides an executable.
        discover(simple, at, depth, walk);
        wrote.extend(effect.writes.iter().filter_map(|w| at.resolve(w)));
        rewrites |= effect.rewrites;
        for run in &effect.runs {
            scripts::show(run, at, depth, walk);
        }
    }
    // A file written (or possibly rewritten) and run by the same command: what runs may not
    // be what was shown.
    let ran = &walk.ran[ran_before..];
    if !ran.is_empty()
        && (rewrites
            || ran
                .iter()
                .any(|run| wrote.iter().any(|written| run.starts_with(written))))
    {
        walk.kind(Sensitive::Unclear);
    }
}

/// Names the shell runs itself, never looked up on `PATH`.
pub fn shell_builtin(name: &str) -> bool {
    matches!(
        name,
        ":" | "."
            | "["
            | "alias"
            | "bg"
            | "break"
            | "cd"
            | "chdir"
            | "command"
            | "continue"
            | "declare"
            | "dirs"
            | "echo"
            | "eval"
            | "exec"
            | "exit"
            | "export"
            | "false"
            | "fg"
            | "getopts"
            | "hash"
            | "jobs"
            | "let"
            | "local"
            | "popd"
            | "printf"
            | "pushd"
            | "pwd"
            | "read"
            | "readonly"
            | "return"
            | "set"
            | "shift"
            | "source"
            | "test"
            | "times"
            | "trap"
            | "true"
            | "type"
            | "typeset"
            | "ulimit"
            | "umask"
            | "unalias"
            | "unset"
            | "wait"
    )
}

/// Whether `command` assigns `PATH` anywhere (`PATH=x cmd`, `export PATH=…`, `PATH+=…`).
fn sets_path(command: &str) -> bool {
    command
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')' | '`'))
        .map(|word| word.trim_start_matches(['"', '\'', '$', '{']))
        .any(|word| word.starts_with("PATH=") || word.starts_with("PATH+="))
}

/// The executable `simple` starts, found from `place`: a program in the bot's folder is a script
/// it runs (read and shown); one elsewhere outside the system's folders is kept so the call is
/// bound to it; one that can't be found leaves the reading incomplete. And the tools it runs that
/// read configuration, with the folder they run in, whose configuration is inspected.
fn discover(simple: &Simple, place: &dyn Place, depth: usize, walk: &mut Walk) {
    let Some(first) = simple.words.first() else {
        return;
    };
    let program = super::secrets::basename(first);
    let tools = ConfigTools::of(program);
    if tools.any() {
        match place.resolve(".") {
            Some(dir) => match walk.config.iter_mut().find(|(d, _)| *d == dir) {
                Some((_, had)) => *had = had.union(tools),
                None => walk.config.push((dir, tools)),
            },
            None => walk.kind(Sensitive::Unclear),
        }
    }
    // A path is run as a script where it is named (`effects`); a name built at run time is
    // already unclear there.
    if first.contains('/') || first.contains('$') || first.contains('`') || shell_builtin(first) {
        return;
    }
    match place.program(first) {
        Program::System | Program::Unknown => {}
        Program::Missing => walk.kind(Sensitive::Unclear),
        Program::At(real) if place.contains(&real) => {
            let run = effects::Run::Exec(real.to_string_lossy().into_owned());
            scripts::show(&run, place, depth, walk);
        }
        Program::At(real) => {
            if !walk.programs.contains(&real) {
                walk.programs.push(real);
            }
        }
    }
}

/// Every simple command in `text`, as words (wrappers taken off, output targets after them);
/// `None` when it can't be read.
pub fn simple_commands(text: &str) -> Option<Vec<Vec<String>>> {
    parse(text, 0)
        .ok()
        .map(|commands| commands.iter().map(with_targets).collect())
}

/// Every simple command in `text` as the parser reads it (words with wrappers taken off, its
/// redirects, pipes, here-document text, subshell depth and folder), for Spade's tool-call
/// classifier (ADR 0172), which reads the same structure as these rules; `None` when it can't be
/// read.
pub fn read(text: &str) -> Option<Vec<Simple>> {
    parse(text, 0).ok()
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
