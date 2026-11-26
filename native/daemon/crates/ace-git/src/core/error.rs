// SPDX-License-Identifier: Apache-2.0
//! `GitError`, `GitErrorCode`, `CleanupResult` and error serialization via `ace-json`.
//! Matches `packages/git/src/types.ts` codes, messages and details shape.

use std::fmt;

use ace_json::{JsString, Map, Number, Value};

/// Every public `GitErrorCode` from `packages/git/src/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GitErrorCode {
    SensitivePublication,
    PublicationScanIncomplete,
    GitMissing,
    GitTooOld,
    GitFailed,
    ObjectsNotAvailable,
    HeadMoved,
    Conflicts,
    HookFailed,
    PushLeaseStale,
    AuthFailed,
    RemoteUnreachable,
    RemoteRefNotFound,
    GitTimeout,
    GitCancelled,
    GitClosed,
    GitBusy,
    GitQuarantined,
    MalformedOutput,
    FilesystemError,
    OutputTooLarge,
    ShallowParent,
    NotARepo,
    InvalidArgument,
    InvalidRef,
    PrBaseMismatch,
    BranchExists,
    DirtyWorktree,
    WorktreeNotFound,
    MainWorktree,
    CheckpointNotFound,
    RestoreCollision,
    UnsupportedRepository,
    PathOutsideRepo,
    NoUpstream,
    PrivatePathStaged,
    StagedMeanwhile,
    // GitFailureCode variants
    BranchCheckedOut,
    PathExists,
    RefConflict,
    UnbornHead,
    IdentityMissing,
    NothingToCommit,
    PushRejected,
    ProtectedBranch,
}

/// Failed Git commands whose stderr names one cause (`gitFailureCodes` in `types.ts`).
pub const GIT_FAILURE_CODES: &[GitErrorCode] = &[
    GitErrorCode::BranchCheckedOut,
    GitErrorCode::PathExists,
    GitErrorCode::RefConflict,
    GitErrorCode::UnbornHead,
    GitErrorCode::IdentityMissing,
    GitErrorCode::NothingToCommit,
    GitErrorCode::PushRejected,
    GitErrorCode::ProtectedBranch,
];

impl GitErrorCode {
    /// Wire string matching TypeScript `GitErrorCode`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SensitivePublication => "sensitive_publication",
            Self::PublicationScanIncomplete => "publication_scan_incomplete",
            Self::GitMissing => "git_missing",
            Self::GitTooOld => "git_too_old",
            Self::GitFailed => "git_failed",
            Self::ObjectsNotAvailable => "objects_not_available",
            Self::HeadMoved => "head_moved",
            Self::Conflicts => "conflicts",
            Self::HookFailed => "hook_failed",
            Self::PushLeaseStale => "push_lease_stale",
            Self::AuthFailed => "auth_failed",
            Self::RemoteUnreachable => "remote_unreachable",
            Self::RemoteRefNotFound => "remote_ref_not_found",
            Self::GitTimeout => "git_timeout",
            Self::GitCancelled => "git_cancelled",
            Self::GitClosed => "git_closed",
            Self::GitBusy => "git_busy",
            Self::GitQuarantined => "git_quarantined",
            Self::MalformedOutput => "malformed_output",
            Self::FilesystemError => "filesystem_error",
            Self::OutputTooLarge => "output_too_large",
            Self::ShallowParent => "shallow_parent",
            Self::NotARepo => "not_a_repo",
            Self::InvalidArgument => "invalid_argument",
            Self::InvalidRef => "invalid_ref",
            Self::PrBaseMismatch => "pr_base_mismatch",
            Self::BranchExists => "branch_exists",
            Self::DirtyWorktree => "dirty_worktree",
            Self::WorktreeNotFound => "worktree_not_found",
            Self::MainWorktree => "main_worktree",
            Self::CheckpointNotFound => "checkpoint_not_found",
            Self::RestoreCollision => "restore_collision",
            Self::UnsupportedRepository => "unsupported_repository",
            Self::PathOutsideRepo => "path_outside_repo",
            Self::NoUpstream => "no_upstream",
            Self::PrivatePathStaged => "private_path_staged",
            Self::StagedMeanwhile => "staged_meanwhile",
            Self::BranchCheckedOut => "branch_checked_out",
            Self::PathExists => "path_exists",
            Self::RefConflict => "ref_conflict",
            Self::UnbornHead => "unborn_head",
            Self::IdentityMissing => "identity_missing",
            Self::NothingToCommit => "nothing_to_commit",
            Self::PushRejected => "push_rejected",
            Self::ProtectedBranch => "protected_branch",
        }
    }

    /// Parse a wire error code string.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "sensitive_publication" => Some(Self::SensitivePublication),
            "publication_scan_incomplete" => Some(Self::PublicationScanIncomplete),
            "git_missing" => Some(Self::GitMissing),
            "git_too_old" => Some(Self::GitTooOld),
            "git_failed" => Some(Self::GitFailed),
            "objects_not_available" => Some(Self::ObjectsNotAvailable),
            "head_moved" => Some(Self::HeadMoved),
            "conflicts" => Some(Self::Conflicts),
            "hook_failed" => Some(Self::HookFailed),
            "push_lease_stale" => Some(Self::PushLeaseStale),
            "auth_failed" => Some(Self::AuthFailed),
            "remote_unreachable" => Some(Self::RemoteUnreachable),
            "remote_ref_not_found" => Some(Self::RemoteRefNotFound),
            "git_timeout" => Some(Self::GitTimeout),
            "git_cancelled" => Some(Self::GitCancelled),
            "git_closed" => Some(Self::GitClosed),
            "git_busy" => Some(Self::GitBusy),
            "git_quarantined" => Some(Self::GitQuarantined),
            "malformed_output" => Some(Self::MalformedOutput),
            "filesystem_error" => Some(Self::FilesystemError),
            "output_too_large" => Some(Self::OutputTooLarge),
            "shallow_parent" => Some(Self::ShallowParent),
            "not_a_repo" => Some(Self::NotARepo),
            "invalid_argument" => Some(Self::InvalidArgument),
            "invalid_ref" => Some(Self::InvalidRef),
            "pr_base_mismatch" => Some(Self::PrBaseMismatch),
            "branch_exists" => Some(Self::BranchExists),
            "dirty_worktree" => Some(Self::DirtyWorktree),
            "worktree_not_found" => Some(Self::WorktreeNotFound),
            "main_worktree" => Some(Self::MainWorktree),
            "checkpoint_not_found" => Some(Self::CheckpointNotFound),
            "restore_collision" => Some(Self::RestoreCollision),
            "unsupported_repository" => Some(Self::UnsupportedRepository),
            "path_outside_repo" => Some(Self::PathOutsideRepo),
            "no_upstream" => Some(Self::NoUpstream),
            "private_path_staged" => Some(Self::PrivatePathStaged),
            "staged_meanwhile" => Some(Self::StagedMeanwhile),
            "branch_checked_out" => Some(Self::BranchCheckedOut),
            "path_exists" => Some(Self::PathExists),
            "ref_conflict" => Some(Self::RefConflict),
            "unborn_head" => Some(Self::UnbornHead),
            "identity_missing" => Some(Self::IdentityMissing),
            "nothing_to_commit" => Some(Self::NothingToCommit),
            "push_rejected" => Some(Self::PushRejected),
            "protected_branch" => Some(Self::ProtectedBranch),
            _ => None,
        }
    }
}

impl fmt::Display for GitErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Settlement of a killed child's cleanup (`CleanupResult` from `@ace/provider-kit/cleanup`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CleanupResult {
    Confirmed { evidence: String },
    Unconfirmed { reason: String },
}

impl CleanupResult {
    pub fn to_json_value(&self) -> Value {
        let mut map = Map::new();
        match self {
            Self::Confirmed { evidence } => {
                map.insert(JsString::from("status"), Value::from("confirmed"));
                map.insert(JsString::from("evidence"), Value::from(evidence.as_str()));
            }
            Self::Unconfirmed { reason } => {
                map.insert(JsString::from("status"), Value::from("unconfirmed"));
                map.insert(JsString::from("reason"), Value::from(reason.as_str()));
            }
        }
        Value::Object(map)
    }

    pub fn to_json_string(&self) -> String {
        ace_json::to_string(&self.to_json_value())
    }
}

/// Core `GitError`, mirroring `packages/git/src/types.ts`.
#[derive(Debug, Clone, PartialEq)]
pub struct GitError {
    pub code: GitErrorCode,
    pub message: String,
    pub details: Box<Map>,
    /// Optional registered cleanup settlement id, resolved by the shell into `error.cleanup.settled`.
    pub cleanup_id: Option<u64>,
    /// Optional POSIX process-group PID for synchronous lease quarantine before rejection.
    pub cleanup_group_pid: Option<u32>,
}

impl GitError {
    pub fn new(code: GitErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: Box::new(Map::new()),
            cleanup_id: None,
            cleanup_group_pid: None,
        }
    }

    pub fn with_details(code: GitErrorCode, message: impl Into<String>, details: Map) -> Self {
        Self {
            code,
            message: message.into(),
            details: Box::new(details),
            cleanup_id: None,
            cleanup_group_pid: None,
        }
    }

    pub fn with_detail(mut self, key: &str, value: Value) -> Self {
        self.details.insert(JsString::from(key), value);
        self
    }

    pub fn with_cleanup_id(mut self, id: u64) -> Self {
        self.cleanup_id = Some(id);
        self
    }

    /// Map a filesystem / OS error with Node-compatible `errno` name to `filesystem_error`.
    pub fn filesystem(errno: impl Into<String>, message: impl Into<String>) -> Self {
        let mut details = Map::new();
        details.insert(JsString::from("errno"), Value::from(errno.into().as_str()));
        Self::with_details(GitErrorCode::FilesystemError, message, details)
    }

    /// Map `std::io::Error` into `filesystem_error` with Node-style errno string.
    pub fn from_io(error: &std::io::Error) -> Self {
        let errno = io_errno_code(error);
        Self::filesystem(errno, error.to_string())
    }

    /// Serialize into the `git_failed:{...}` payload format parsed by `native-common.ts`.
    pub fn to_payload(&self) -> String {
        let mut root = Map::new();
        root.insert(JsString::from("code"), Value::from(self.code.as_str()));
        root.insert(
            JsString::from("message"),
            Value::from(self.message.as_str()),
        );
        root.insert(
            JsString::from("details"),
            Value::Object((*self.details).clone()),
        );
        if let Some(id) = self.cleanup_id {
            root.insert(
                JsString::from("cleanupId"),
                Value::Number(Number::from(id as f64)),
            );
        }
        if let Some(pid) = self.cleanup_group_pid {
            root.insert(
                JsString::from("cleanupGroupPid"),
                Value::Number(Number::from(pid as f64)),
            );
        }
        ace_json::to_string(&Value::Object(root))
    }

    /// `isMutationUnavailable`: a quarantine refusal, or any failure whose cleanup receipt
    /// outlives its supervised ownership. `git_busy` alone is an ordinary retryable refusal.
    pub fn is_mutation_unavailable(&self) -> bool {
        self.code == GitErrorCode::GitQuarantined || self.cleanup_id.is_some()
    }
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for GitError {}

/// Node-style errno string for an `std::io::Error`.
pub fn io_errno_code(error: &std::io::Error) -> &'static str {
    if let Some(raw) = error.raw_os_error() {
        #[cfg(unix)]
        match raw {
            libc::ENOENT => return "ENOENT",
            libc::EACCES => return "EACCES",
            libc::EPERM => return "EPERM",
            libc::EEXIST => return "EEXIST",
            libc::ENOTDIR => return "ENOTDIR",
            libc::EISDIR => return "EISDIR",
            libc::EBUSY => return "EBUSY",
            libc::EIO => return "EIO",
            libc::EPIPE => return "EPIPE",
            libc::EMFILE => return "EMFILE",
            libc::ENFILE => return "ENFILE",
            libc::ENOSPC => return "ENOSPC",
            libc::EROFS => return "EROFS",
            libc::ETIMEDOUT => return "ETIMEDOUT",
            libc::ECONNREFUSED => return "ECONNREFUSED",
            libc::EINVAL => return "EINVAL",
            libc::ENAMETOOLONG => return "ENAMETOOLONG",
            libc::ELOOP => return "ELOOP",
            libc::EXDEV => return "EXDEV",
            libc::ENOTEMPTY => return "ENOTEMPTY",
            _ => {}
        }
        #[cfg(windows)]
        match raw {
            2 | 3 => return "ENOENT",
            5 => return "EACCES",
            17 => return "EEXIST",
            32 | 33 => return "EBUSY",
            183 => return "EEXIST",
            267 => return "ENOTDIR",
            _ => {}
        }
    }
    match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        std::io::ErrorKind::BrokenPipe => "EPIPE",
        std::io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
        std::io::ErrorKind::TimedOut => "ETIMEDOUT",
        std::io::ErrorKind::InvalidInput => "EINVAL",
        std::io::ErrorKind::NotADirectory => "ENOTDIR",
        std::io::ErrorKind::IsADirectory => "EISDIR",
        std::io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
        _ => "EIO",
    }
}

/// Convert a string slice vec into an `ace_json::Value::Array`.
pub fn json_string_array(items: &[String]) -> Value {
    Value::Array(items.iter().map(|s| Value::from(s.as_str())).collect())
}

/// Probe stub kept for compatibility with G0 callers.
pub fn probe(op: &str) -> Result<(), crate::error::Error> {
    Err(crate::error::Error::unimplemented("core::error", op))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quarantine_refusal_or_a_cleanup_receipt_means_mutation_is_unavailable() {
        assert!(GitError::new(GitErrorCode::GitQuarantined, "locked").is_mutation_unavailable());
        // A busy call limit or a busy lease is retryable, not a quarantined mutation.
        assert!(!GitError::new(GitErrorCode::GitBusy, "busy").is_mutation_unavailable());
        assert!(!GitError::new(GitErrorCode::GitFailed, "failed").is_mutation_unavailable());
        // The cleanup a bounded failure left behind outlives this call: the mutation is not
        // available until its settlement is confirmed.
        assert!(
            GitError::new(GitErrorCode::GitTimeout, "timed out")
                .with_cleanup_id(7)
                .is_mutation_unavailable()
        );
    }
}
