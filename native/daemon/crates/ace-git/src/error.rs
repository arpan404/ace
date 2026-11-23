// SPDX-License-Identifier: Apache-2.0
//! The crate's typed errors, mapped by the binding to `git_failed` JS errors.
//! G0 stub: only the deferral the shells run on today; each item adds the
//! failure variants its module can return, in its own module.

/// What a stubbed git operation reports before it defers to TypeScript.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// The native core is not ported yet; the shell runs the TypeScript path
    /// and counts the fallback. Never a failure, never partial.
    #[error("ace-git {part} is not ported yet; deferred to TypeScript ({op})")]
    Unimplemented { part: String, op: String },
    /// Something the binding cannot carry; thrown as `git_failed`, never deferred.
    #[error("ace-git internal failure: {0}")]
    Internal(String),
}

impl Error {
    /// The G0 deferral for `op` of `part`.
    pub fn unimplemented(part: &str, op: &str) -> Self {
        Self::Unimplemented {
            part: part.to_owned(),
            op: op.to_owned(),
        }
    }

    /// The `GitError` code the shell throws for this error.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unimplemented { .. } | Self::Internal(_) => "git_failed",
        }
    }

    /// True while the shell must defer to TypeScript instead of failing.
    pub fn is_stub(&self) -> bool {
        matches!(self, Self::Unimplemented { .. })
    }

    /// The `git_failed:{...}` payload the binding throws; the shell parses
    /// it back into a `GitError`, so `instanceof` holds.
    pub fn to_payload(&self) -> String {
        match self {
            Self::Unimplemented { part, op } => format!(
                "{{\"code\":\"git_failed\",\"message\":\"ace-git {part} is not ported yet\",\"details\":{{\"stub\":true,\"part\":\"{part}\",\"op\":\"{op}\"}}}}"
            ),
            Self::Internal(message) => format!(
                "{{\"code\":\"git_failed\",\"message\":\"ace-git internal failure: {message}\",\"details\":{{\"stub\":false}}}}"
            ),
        }
    }
}
