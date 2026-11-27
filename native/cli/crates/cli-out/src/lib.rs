// SPDX-License-Identifier: Apache-2.0
//! Who is on the other end of a run, and where its words go (ADR 0178 §3, §9, §10).

mod failure;
mod flags;

pub use failure::{ErrorCode, Failure, Outcome, Problem, Retry, human_error};
pub use flags::{FlagValue, Flags};

use std::fmt;
use std::io::{self, BufWriter, Write};

use serde::Serialize;

/// How a run prints: words for a person, one JSON value, or nothing but identifiers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputMode {
    Human,
    Json,
    Quiet,
}

/// True when a value turns a switch-like variable on: set, and not empty, 0 or false.
#[must_use]
pub fn env_on(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        let value = value.trim().to_lowercase();
        !matches!(value.as_str(), "" | "0" | "false" | "no")
    })
}

/// The flag that decides the mode: `--json`, `--jq`, `--stream jsonl`, else `--quiet`.
#[must_use]
pub fn output_mode(flags: &Flags<'_>) -> OutputMode {
    if flags.on("json") || flags.has("jq") || flags.value("stream") == Some("jsonl") {
        OutputMode::Json
    } else if flags.on("quiet") {
        OutputMode::Quiet
    } else {
        OutputMode::Human
    }
}

/// The environment facts a run's decisions read, gathered once by the shell.
#[derive(Clone, Debug, Default)]
pub struct Env {
    pub no_input: Option<String>,
    pub thread_id: Option<String>,
    pub no_color: Option<String>,
    pub force_color: Option<String>,
}

impl Env {
    /// The environment this process runs in. The only I/O in this crate's decisions.
    #[must_use]
    pub fn from_process() -> Self {
        let read = |name: &str| std::env::var(name).ok();
        Self {
            no_input: read("ACE_NO_INPUT"),
            thread_id: read("ACE_THREAD_ID"),
            no_color: read("NO_COLOR"),
            force_color: read("FORCE_COLOR"),
        }
    }
}

/// Which of a run's streams is a terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terminal {
    pub stdin: bool,
    pub stdout: bool,
    pub stderr: bool,
}

impl Terminal {
    #[must_use]
    pub fn none() -> Self {
        Self {
            stdin: false,
            stdout: false,
            stderr: false,
        }
    }
}

/// Whether a command may ask the person anything (ADR 0178 §9).
#[must_use]
pub fn can_prompt(flags: &Flags<'_>, env: &Env, terminal: Terminal) -> bool {
    if !terminal.stdin || !terminal.stdout {
        return false;
    }
    if flags.on("no-input") || output_mode(flags) != OutputMode::Human {
        return false;
    }
    if env_on(env.no_input.as_deref()) {
        return false;
    }
    env.thread_id
        .as_deref()
        .is_none_or(|thread| thread.trim().is_empty())
}

/// Which stream colour is being chosen for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Colour only for state, only on a terminal, and never against `NO_COLOR` (§3).
#[must_use]
pub fn use_color(flags: &Flags<'_>, env: &Env, terminal: Terminal, stream: Stream) -> bool {
    match flags.value("color") {
        Some("always") => return true,
        Some("never") => return false,
        _ => {}
    }
    if output_mode(flags) == OutputMode::Json {
        return false;
    }
    if env
        .no_color
        .as_deref()
        .is_some_and(|value| !value.is_empty())
    {
        return false;
    }
    if env_on(env.force_color.as_deref()) {
        return true;
    }
    match stream {
        Stream::Stdout => terminal.stdout,
        Stream::Stderr => terminal.stderr,
    }
}

/// Nothing a run prints failed in a way a person can act on; the exit code says the rest.
#[derive(Debug)]
pub enum WriteError {
    Io(io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for WriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Json(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for WriteError {}

impl From<io::Error> for WriteError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for WriteError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// One buffered writer per run, flushed once. Locking happens before it is built.
pub struct Out<W: Write> {
    writer: BufWriter<W>,
}

impl<W: Write> Out<W> {
    pub fn new(writer: W) -> Self {
        Self {
            writer: BufWriter::with_capacity(16 * 1024, writer),
        }
    }

    pub fn write(&mut self, text: &str) -> Result<(), WriteError> {
        self.writer.write_all(text.as_bytes())?;
        Ok(())
    }

    /// A human line: the text and one newline.
    pub fn line(&mut self, text: &str) -> Result<(), WriteError> {
        self.write(text)?;
        self.write("\n")
    }

    /// One JSON value, compact as TypeScript's `JSON.stringify` writes it.
    pub fn json<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), WriteError> {
        serde_json::to_writer(&mut self.writer, value)?;
        self.write("\n")
    }

    /// One JSON value, indented two spaces, as a person reads it.
    pub fn json_pretty<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), WriteError> {
        serde_json::to_writer_pretty(&mut self.writer, value)?;
        self.write("\n")
    }

    pub fn flush(&mut self) -> Result<(), WriteError> {
        self.writer.flush()?;
        Ok(())
    }
}

/// One value in the mode asked for, text as it is and everything else as JSON.
pub fn write_value<W: Write, T: Serialize + ?Sized>(
    out: &mut Out<W>,
    mode: OutputMode,
    value: &T,
) -> Result<(), WriteError> {
    match mode {
        OutputMode::Json => out.json(value),
        OutputMode::Human | OutputMode::Quiet => out.json_pretty(value),
    }
}
