// SPDX-License-Identifier: Apache-2.0
//! The shape of ace's command table (ADR 0178 §5), as static data.
//!
//! Everything here is `&'static`: the table is compiled in by `build.rs` from
//! `native/cli/table.json`, so a run parses no JSON and allocates no index. Lookups are binary
//! searches over generated sorted arrays.

/// Where a command sits in `ace help`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    Basics,
    Work,
    Machine,
    Providers,
    SpadeMarket,
    AgentTools,
}

impl Group {
    /// The JSON name the TypeScript table uses.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Basics => "basics",
            Self::Work => "work",
            Self::Machine => "machine",
            Self::Providers => "providers",
            Self::SpadeMarket => "spade-market",
            Self::AgentTools => "agent-tools",
        }
    }

    /// The group named by the table's JSON, or `None` for a group this build doesn't know.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "basics" => Self::Basics,
            "work" => Self::Work,
            "machine" => Self::Machine,
            "providers" => Self::Providers,
            "spade-market" => Self::SpadeMarket,
            "agent-tools" => Self::AgentTools,
            _ => return None,
        })
    }
}

/// What a value names, so completion can ask the daemon for the live ones (ADR 0178 §6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefKind {
    Thread,
    Project,
    Request,
    Bot,
}

impl RefKind {
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "thread" => Self::Thread,
            "project" => Self::Project,
            "request" => Self::Request,
            "bot" => Self::Bot,
            _ => return None,
        })
    }
}

/// A flag's one specification.
#[derive(Debug)]
pub struct FlagSpec {
    pub name: &'static str,
    /// One letter, used as `-x`.
    pub short: Option<&'static str>,
    /// The placeholder in help (`ID`, `DURATION`); a flag without one is a switch.
    pub value: Option<&'static str>,
    pub summary: &'static str,
    /// May be given more than once; values collect in `Parsed::lists`.
    pub repeat: bool,
    pub choices: &'static [&'static str],
    /// The value names one of these, which completion offers live from the daemon.
    pub reference: Option<RefKind>,
    /// Accepted, never shown: old spellings kept for the deprecation window.
    pub hidden: bool,
}

/// A positional argument's specification.
#[derive(Debug)]
pub struct ArgSpec {
    pub name: &'static str,
    pub summary: &'static str,
    pub required: bool,
    /// Takes every remaining word.
    pub variadic: bool,
    /// `-` reads this argument from stdin.
    pub stdin: bool,
    pub reference: Option<RefKind>,
}

/// One example line in a command's help.
#[derive(Debug)]
pub struct Example {
    pub command: &'static str,
    pub summary: &'static str,
}

/// Another spelling of a command (ADR 0178 decision 6).
#[derive(Debug)]
pub struct AliasSpec {
    pub words: &'static [&'static str],
    /// The release the new spelling shipped in; absent for a permanent shortcut.
    pub deprecated_since: Option<&'static str>,
    /// Words put before the positional ones (`login codex` → `provider login codex`).
    pub insert_words: &'static [&'static str],
    /// Positional words become these flags, in order (`thread approve ID` → `--thread ID`).
    pub words_as: &'static [&'static str],
    /// Old flag name → new flag name.
    pub rename_flags: &'static [(&'static str, &'static str)],
    /// Switches the alias turns on (`task wait` → `--tree`).
    pub set_flags: &'static [&'static str],
    /// A flag that, when given, sends the alias to another command (`clean --compact`).
    pub by_flag: &'static [(&'static str, &'static str)],
    /// Never listed as a shortcut in help (plural nouns).
    pub quiet: bool,
}

impl AliasSpec {
    /// The new name of a renamed flag, if the alias renames it.
    #[must_use]
    pub fn renamed(&self, name: &str) -> Option<&'static str> {
        self.rename_flags
            .iter()
            .find(|(old, _)| *old == name)
            .map(|(_, new)| *new)
    }
}

/// An exit code a command uses beyond the usual ones.
#[derive(Debug)]
pub struct ExitSpec {
    pub code: u16,
    pub when: &'static str,
}

/// Who a person-only action belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PersonOnly {
    Answer,
    Setting,
    Install,
}

impl PersonOnly {
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "answer" => Self::Answer,
            "setting" => Self::Setting,
            "install" => Self::Install,
            _ => return None,
        })
    }
}

/// One command.
#[derive(Debug)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the table is data; one field per fact it records"
)]
pub struct CommandSpec {
    /// Dotted words: `thread.list`, `market.maintainer.sign`.
    pub id: &'static str,
    pub words: &'static [&'static str],
    pub summary: &'static str,
    pub description: Option<&'static str>,
    pub group: Group,
    pub args: &'static [ArgSpec],
    pub flags: &'static [FlagSpec],
    pub examples: &'static [Example],
    pub aliases: &'static [AliasSpec],
    pub exits: &'static [ExitSpec],
    pub see_also: &'static [&'static str],
    /// Key into `cli-outputs` for `--json` and `--schema`.
    pub output: Option<&'static str>,
    pub mutates: bool,
    /// Works with the daemon down: help, version, completion, doctor, triage (ADR 0092).
    pub offline: bool,
    /// Not in `ace help` or completions (maintainer tools, the release runtime, `__complete`).
    pub hidden: bool,
    /// What a bare noun runs: `ace thread` is `ace thread list`.
    pub noun_default: bool,
    /// The person's alone (ADR 0178 §12.5).
    pub person_only: Option<PersonOnly>,
    /// Every word after the command's own goes to it unparsed.
    pub passthrough: bool,
}

/// A noun's page metadata.
#[derive(Debug)]
pub struct NounSpec {
    pub name: &'static str,
    pub summary: &'static str,
    pub description: Option<&'static str>,
    pub group: Group,
    pub hidden: bool,
}

/// A help topic's page.
#[derive(Debug)]
pub struct TopicSpec {
    pub name: &'static str,
    pub summary: &'static str,
    pub text: &'static str,
}

/// What one exit code means.
#[derive(Debug)]
pub struct ExitCodeMeaning {
    pub code: u8,
    pub name: &'static str,
    pub means: &'static str,
}

/// One way to reach a command: its own words, or one of its aliases.
#[derive(Clone, Copy, Debug)]
pub struct Route {
    pub command: &'static CommandSpec,
    pub alias: Option<&'static AliasSpec>,
}
