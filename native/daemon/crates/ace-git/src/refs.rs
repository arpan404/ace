// SPDX-License-Identifier: Apache-2.0
//! Ref, branch and worktree-list reads on `gix` (G1 of `docs/git/porting-guide.md`,
//! ADR 0224 §4 and §6).
//!
//! Each read reproduces exactly the Git command today's TypeScript service runs, and hands
//! its caller's decoder the bytes that command prints: `worktree list --porcelain -z`
//! records for `parseWorktrees`, `for-each-ref` lines for `parseRef` and `listBranches`, and
//! the two `rev-parse` answers for `Repository.commit` and `branchHead`. No decoder is
//! shared between callers and none is duplicated here.
//!
//! Anything `gix` cannot reproduce exactly is a fallback, never a guess: a reftable
//! repository (`reftable`), a worktree whose prunable or locked reason `gix` cannot word as
//! Git does (`worktree_reason`), and a repository `gix` cannot read (`unreadable`). The
//! shell then runs the same Git command in the same `serial` turn. The remaining reasons in
//! the guide are the shell's: a held directory (`directory_fd`) and an injected
//! `gitBinary` or `spawn` (`injected`).

use gix::bstr::{BStr, ByteSlice};

mod listing;

/// Why a read cannot be reproduced exactly; the shell runs the same Git command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fallback {
    /// A reftable repository: `gix` reads the file backend only.
    Reftable,
    /// A prunable worktree, or a lock reason `gix` doesn't word as Git does.
    WorktreeReason,
    /// A repository `gix` cannot open or read; Git decides what that means.
    Unreadable,
}

impl Fallback {
    /// The `ace-json` payload the shell reads as "run the CLI", and why.
    pub fn payload(self) -> String {
        ace_json::ser::to_string(&Refusal {
            fallback: self.reason(),
        })
        .unwrap_or_else(|_| String::from("{\"fallback\":\"unreadable\"}"))
    }

    /// The reason the operation log and `resourceUsage().nativeFallbacks` name.
    pub fn reason(self) -> &'static str {
        match self {
            Self::Reftable => "reftable",
            Self::WorktreeReason => "worktree_reason",
            Self::Unreadable => "unreadable",
        }
    }
}

/// What a read produced: the data a caller's decoder reads, or why the CLI must run.
#[derive(Debug)]
pub enum Outcome<T> {
    Data(T),
    Fallback(Fallback),
}

impl<T> Outcome<T> {
    pub(crate) fn data(value: T) -> Self {
        Self::Data(value)
    }

    pub(crate) fn fallback(reason: Fallback) -> Self {
        Self::Fallback(reason)
    }
}

/// Who a `rev-parse --verify <ref>^{commit}` resolved: the same three answers the TypeScript
/// service derives from the exit code and the `symbolic-ref --quiet HEAD` that follows it.
#[derive(Debug, serde::Serialize)]
pub struct CommitResolution {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
}

impl CommitResolution {
    fn commit(id: gix::hash::ObjectId) -> Self {
        Self {
            kind: "commit",
            id: Some(id.to_string()),
        }
    }

    fn unborn() -> Self {
        Self {
            kind: "unborn",
            id: None,
        }
    }

    fn missing() -> Self {
        Self {
            kind: "missing",
            id: None,
        }
    }
}

/// A read that could not be reproduced exactly, as the shell reads it back.
#[derive(Debug, serde::Serialize)]
struct Refusal<'a> {
    fallback: &'a str,
}

/// The `ace-json` text the binding returns for a read: its data, or the fallback reason.
pub fn reply<T: serde::Serialize>(outcome: &Outcome<T>) -> Result<String, crate::error::Error> {
    match outcome {
        Outcome::Data(value) => ace_json::ser::to_string(value)
            .map_err(|error| crate::error::Error::Internal(error.to_string())),
        Outcome::Fallback(reason) => Ok(reason.payload()),
    }
}

/// The `rev-parse --verify <ref>^{commit}` answer and, on failure, the unborn check.
pub fn resolve_commit(root: &str, reference: &str) -> Outcome<CommitResolution> {
    let Some(repo) = open(root) else {
        return Outcome::fallback(Fallback::Unreadable);
    };
    if reftable(&repo) {
        return Outcome::fallback(Fallback::Reftable);
    }
    if let Some(id) = commit_spec(&repo, reference) {
        return Outcome::data(CommitResolution::commit(id));
    }
    // `HEAD` naming a branch with no commit yet is a new repository, not a bad ref. Git asks
    // `symbolic-ref --quiet HEAD`, which succeeds for any symbolic HEAD, born or not.
    let symbolic = repo.head().is_ok_and(|head| head.referent_name().is_some());
    if reference == "HEAD" && symbolic {
        Outcome::data(CommitResolution::unborn())
    } else {
        Outcome::data(CommitResolution::missing())
    }
}

/// The commit of a local or remote-tracking branch, or `None` when that ref is missing or
/// doesn't peel to a commit (`rev-parse --verify --quiet <ref>^{commit}`).
pub fn branch_head(root: &str, reference: &str) -> Outcome<Option<String>> {
    let Some(repo) = open(root) else {
        return Outcome::fallback(Fallback::Unreadable);
    };
    if reftable(&repo) {
        return Outcome::fallback(Fallback::Reftable);
    }
    let commit = repo
        .find_reference(reference)
        .ok()
        .and_then(|mut found| found.peel_to_kind(gix::object::Kind::Commit).ok())
        .map(|object| object.id);
    Outcome::data(commit.map(|id| id.to_string()))
}

/// `for-each-ref`'s lines for `remote-branches.ts`'s format, in its sort order, with `--count`.
pub fn branch_refs(root: &str, patterns: &[String], count: u32) -> Outcome<Vec<u8>> {
    let Some(repo) = open(root) else {
        return Outcome::fallback(Fallback::Unreadable);
    };
    if reftable(&repo) {
        return Outcome::fallback(Fallback::Reftable);
    }
    match listing::branch_refs(&repo, patterns, count) {
        Some(lines) => Outcome::data(lines),
        None => Outcome::fallback(Fallback::Unreadable),
    }
}

/// `for-each-ref`'s `%(refname:short)` lines, in ref name order, with `--count`.
pub fn branch_names(root: &str, patterns: &[String], count: u32) -> Outcome<Vec<u8>> {
    let Some(repo) = open(root) else {
        return Outcome::fallback(Fallback::Unreadable);
    };
    if reftable(&repo) {
        return Outcome::fallback(Fallback::Reftable);
    }
    match listing::branch_names(&repo, patterns, count) {
        Some(lines) => Outcome::data(lines),
        None => Outcome::fallback(Fallback::Unreadable),
    }
}

/// Open the repository the read runs in; `None` defers to Git, which words the failure.
pub(crate) fn open(root: &str) -> Option<gix::Repository> {
    gix::open(root).ok()
}

/// A reftable repository, which `gix`'s file backend would read as empty.
pub(crate) fn reftable(repo: &gix::Repository) -> bool {
    let configured = repo
        .config_snapshot()
        .string("extensions.refstorage")
        .is_some_and(|value| value.as_bstr().eq_ignore_ascii_case(b"reftable"));
    configured || repo.git_dir().join("reftable").is_dir()
}

/// Resolve `<reference>^{commit}` exactly as `rev-parse --verify` does.
fn commit_spec(repo: &gix::Repository, reference: &str) -> Option<gix::hash::ObjectId> {
    let spec = format!("{reference}^{{commit}}");
    repo.rev_parse_single(spec.as_str())
        .ok()
        .map(|id| id.detach())
}

/// A ref's short name by `shorten_unambiguous_ref`: the most specific prefix rule whose
/// candidate no other existing ref could also be named by, else the full name.
pub(crate) fn shorten(name: &BStr, exists: &impl Fn(&BStr) -> bool) -> Vec<u8> {
    const STRIP: [(&[u8], &[u8]); 6] = [
        (b"refs/remotes/", b"/HEAD"),
        (b"refs/remotes/", b""),
        (b"refs/heads/", b""),
        (b"refs/tags/", b""),
        (b"refs/", b""),
        (b"", b""),
    ];
    let full = name.as_bytes();
    for (prefix, suffix) in STRIP {
        let Some(candidate) = full
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix(suffix))
            .filter(|candidate| !candidate.is_empty())
        else {
            continue;
        };
        if !ambiguous(candidate, full, exists) {
            return candidate.to_vec();
        }
    }
    full.to_vec()
}

/// Whether `candidate` could name another existing ref through one of Git's rules.
fn ambiguous(candidate: &[u8], full: &[u8], exists: &impl Fn(&BStr) -> bool) -> bool {
    expansions(candidate)
        .iter()
        .any(|other| other.as_slice() != full && exists(BStr::new(other)))
}

/// The refs a name could be, in `ref_rev_parse_rules` order.
fn expansions(name: &[u8]) -> [Vec<u8>; 6] {
    [
        name.to_vec(),
        [b"refs/".as_slice(), name].concat(),
        [b"refs/tags/".as_slice(), name].concat(),
        [b"refs/heads/".as_slice(), name].concat(),
        [b"refs/remotes/".as_slice(), name].concat(),
        [b"refs/remotes/".as_slice(), name, b"/HEAD"].concat(),
    ]
}

#[cfg(test)]
mod tests {
    use super::{Fallback, Outcome};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    /// A scratch checkout, removed when the test ends.
    struct Scratch {
        path: PathBuf,
    }

    impl Scratch {
        fn new() -> std::io::Result<Self> {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("ace-git-refs-{id}-{}", std::process::id()));
            std::fs::create_dir_all(&path)?;
            Ok(Self { path })
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn git(&self) -> PathBuf {
            self.path.join(".git")
        }

        fn write(&self, relative: &str, contents: &str) -> std::io::Result<()> {
            let path = self.git().join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, contents)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// An empty repository: HEAD on an unborn `main`, no objects, no refs.
    fn repository(scratch: &Scratch) -> std::io::Result<()> {
        std::fs::create_dir_all(scratch.git().join("objects"))?;
        std::fs::create_dir_all(scratch.git().join("refs/heads"))?;
        scratch.write("HEAD", "ref: refs/heads/main\n")?;
        scratch.write(
            "config",
            "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n",
        )
    }

    fn root(scratch: &Scratch) -> String {
        scratch.path().to_string_lossy().into_owned()
    }

    /// A reftable repository is `gix`'s file backend's blind spot: every ref read defers.
    #[test]
    fn a_reftable_repository_defers_the_ref_reads_to_git() -> Result<(), Box<dyn std::error::Error>>
    {
        let scratch = Scratch::new()?;
        repository(&scratch)?;
        scratch.write(
            "config",
            "[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\trefstorage = reftable\n",
        )?;
        std::fs::create_dir_all(scratch.git().join("reftable"))?;
        let root = root(&scratch);
        assert!(matches!(
            crate::worktrees_gix::worktrees(&root),
            Outcome::Fallback(Fallback::Reftable)
        ));
        assert!(matches!(
            super::branch_refs(&root, &["refs/heads".to_owned()], 0),
            Outcome::Fallback(Fallback::Reftable)
        ));
        assert!(matches!(
            super::resolve_commit(&root, "HEAD"),
            Outcome::Fallback(Fallback::Reftable)
        ));
        Ok(())
    }

    /// A prunable worktree's reason is Git's wording: the listing defers so Git prints it.
    #[test]
    fn a_prunable_worktree_defers_the_worktree_listing_to_git()
    -> Result<(), Box<dyn std::error::Error>> {
        let scratch = Scratch::new()?;
        repository(&scratch)?;
        let gone = scratch.path().join("gone").join(".git");
        scratch.write("worktrees/gone/gitdir", &format!("{}\n", gone.display()))?;
        scratch.write("worktrees/gone/HEAD", "ref: refs/heads/gone\n")?;
        assert!(matches!(
            crate::worktrees_gix::worktrees(&root(&scratch)),
            Outcome::Fallback(Fallback::WorktreeReason)
        ));
        Ok(())
    }
}
