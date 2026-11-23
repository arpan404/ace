// SPDX-License-Identifier: Apache-2.0
//! What a read line is: the command it reached, a bare noun, or the usage problem with it.

use cli_out::{ErrorCode, Flags};
use cli_table::{AliasSpec, ArgSpec, CommandSpec};

/// A command line that reached a command.
#[derive(Debug)]
pub struct Parsed<'a> {
    pub command: &'static CommandSpec,
    /// The alias the person typed, when they didn't use the command's own words.
    pub alias: Option<&'static AliasSpec>,
    /// The words that named the command, as typed.
    pub typed: Vec<&'a str>,
    /// Positional arguments only, after the command's words.
    pub words: Vec<&'a str>,
    pub flags: Flags<'a>,
    /// Every value of a flag given more than once.
    pub lists: Vec<(&'static str, Vec<&'a str>)>,
    /// Required arguments not given; prompted for on a terminal, a usage error elsewhere.
    pub missing: Vec<&'static ArgSpec>,
}

/// A noun typed without a verb, when the noun has no default: its help is the answer.
#[derive(Debug)]
pub struct NounOnly<'a> {
    pub words: Vec<&'a str>,
    pub flags: Flags<'a>,
}

/// A command line that was wrong.
#[derive(Debug)]
pub struct Usage<'a> {
    pub code: ErrorCode,
    pub message: String,
    pub hint: Option<String>,
    pub suggestion: Option<String>,
    pub argument: Option<String>,
    pub command: Option<&'static str>,
    pub flags: Flags<'a>,
}

impl std::fmt::Display for Usage<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Usage<'_> {}

/// What a command line turned out to be.
#[derive(Debug)]
pub enum ParseResult<'a> {
    Command(Parsed<'a>),
    Noun(NounOnly<'a>),
    Usage(Usage<'a>),
}

/// A problem found while reading, before it knows which flags the line carried.
#[derive(Debug)]
pub(crate) struct Problem {
    pub(crate) code: ErrorCode,
    pub(crate) message: String,
    pub(crate) hint: Option<String>,
    pub(crate) suggestion: Option<String>,
    pub(crate) argument: Option<String>,
    pub(crate) command: Option<&'static str>,
}

impl Problem {
    pub(crate) fn new(code: ErrorCode, message: String) -> Self {
        Self {
            code,
            message,
            hint: None,
            suggestion: None,
            argument: None,
            command: None,
        }
    }

    pub(crate) fn with_argument(mut self, argument: &str) -> Self {
        self.argument = Some(argument.to_owned());
        self
    }

    pub(crate) fn with_hint(mut self, hint: String) -> Self {
        self.hint = Some(hint);
        self
    }

    pub(crate) fn with_suggestion(mut self, suggestion: String) -> Self {
        self.suggestion = Some(suggestion);
        self
    }

    pub(crate) fn with_command(mut self, command: &'static str) -> Self {
        self.command = Some(command);
        self
    }
}

/// What one line carries as it is read.
#[derive(Debug, Default)]
pub(crate) struct Line<'a> {
    pub(crate) flags: Flags<'a>,
    pub(crate) lists: Vec<(&'static str, Vec<&'a str>)>,
}
