// SPDX-License-Identifier: Apache-2.0
//! Shared error type for process supervision: one typed enum, mapped in the binding.

/// What a supervision call failed with. Messages stay stable for the shell's warnings.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SupervisorError {
    /// A caller gave a value the kernel or schema cannot take.
    #[error("invalid process input: {0}")]
    InvalidInput(String),
    /// The kernel would not say what was asked (an unreadable process, a refused probe).
    #[error("kernel process unavailable: {0}")]
    Unavailable(String),
    /// Spawning, signalling or waiting on the OS failed.
    #[error("process operation failed: {0}")]
    Operation(String),
    /// The journal (SQLite) refused a read or write.
    #[error("process journal failed: {0}")]
    Journal(String),
    /// The inventory is full (4,096 rows), or a launch exceeds the kernel's limits.
    #[error("process limit reached: {0}")]
    Limit(String),
    /// The handle is closed; the process it owned is gone from supervision.
    #[error("supervision handle is closed")]
    Closed,
}

impl SupervisorError {
    /// Wraps an OS error with what was being done.
    pub fn operation(action: &str, error: std::io::Error) -> Self {
        Self::Operation(format!("{action}: {error}"))
    }

    /// Wraps a journal error with what was being done.
    pub fn journal(action: &str, error: ace_store::Error) -> Self {
        Self::Journal(format!("{action}: {error}"))
    }
}

impl From<SupervisorError> for String {
    fn from(error: SupervisorError) -> Self {
        error.to_string()
    }
}
