// SPDX-License-Identifier: Apache-2.0
//! The crate's typed errors, mapped by the binding to `git_failed` JS errors.

use crate::core::error::GitError;

/// What a git operation reports when it fails or defers to TypeScript.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum Error {
    /// The native part is not ported yet; the shell runs the TypeScript path
    /// and counts the fallback. Never a failure, never partial.
    #[error("ace-git {part} is not ported yet; deferred to TypeScript ({op})")]
    Unimplemented { part: String, op: String },
    /// A typed Git failure matching `packages/git/src/types.ts`'s `GitError`.
    #[error("{0}")]
    Git(#[from] Box<GitError>),
    /// Something the binding cannot carry; thrown as `git_failed`, never deferred.
    #[error("ace-git internal failure: {0}")]
    Internal(String),
}

impl From<GitError> for Error {
    fn from(error: GitError) -> Self {
        Self::Git(Box::new(error))
    }
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
            Self::Git(error) => error.code.as_str(),
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
            Self::Git(error) => error.to_payload(),
            Self::Internal(message) => GitError::new(
                crate::core::error::GitErrorCode::GitFailed,
                format!("ace-git internal failure: {message}"),
            )
            .with_detail("stub", ace_json::Value::Bool(false))
            .to_payload(),
        }
    }
}
