// SPDX-License-Identifier: Apache-2.0
//! The three kinds of Claude failure and the code the facade registers for each
//! (claude-session.md section 3). A builder must never mix them up: a refused send can be
//! retried, an uncertain one may already have reached the CLI.

use thiserror::Error;

/// A send that reached nothing: the facade throws `InputRejected`.
pub const CODE_INPUT_REJECTED: &str = "ACE_INPUT_REJECTED";
/// A send whose bytes may have reached the CLI: the facade throws a plain `Error`.
pub const CODE_UNCERTAIN: &str = "ACE_CLAUDE_UNCERTAIN";
/// The CLI answered a control request with an error: its text is kept verbatim.
pub const CODE_CONTROL: &str = "ACE_CLAUDE_CONTROL";

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ClaudeError {
    /// Nothing reached the CLI (`ACE_INPUT_REJECTED`).
    #[error("{0}")]
    Refused(String),
    /// The bytes may have reached the CLI (`ACE_CLAUDE_UNCERTAIN`).
    #[error("{0}")]
    Uncertain(String),
    /// A control response's error text (`ACE_CLAUDE_CONTROL`).
    #[error("{0}")]
    Provider(String),
}

impl ClaudeError {
    /// The code the binding registers for this kind.
    pub fn code(&self) -> &'static str {
        match self {
            ClaudeError::Refused(_) => CODE_INPUT_REJECTED,
            ClaudeError::Uncertain(_) => CODE_UNCERTAIN,
            ClaudeError::Provider(_) => CODE_CONTROL,
        }
    }
}
