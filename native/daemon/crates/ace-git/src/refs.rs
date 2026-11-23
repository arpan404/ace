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
//! repository (`reftable`), a repository whose object or ancestry view Git changes
//! (`replace`, `grafts`, `shallow`), `core.warnAmbiguousRefs=false` shortening
//! (`ambiguous_refs`), a worktree whose prunable or locked reason `gix` cannot word as Git
//! does (`worktree_reason`), and a repository `gix` cannot read (`unreadable`). A read whose
//! caller aborted it stops and answers `cancelled`. The shell then runs the same Git command
//! in the same `serial` turn; the remaining reasons are the shell's: a held directory
//! (`directory_fd`) and an injected `gitBinary` or `spawn` (`injected`).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use gix::bstr::{BStr, ByteSlice};

mod listing;

/// Why a read cannot be reproduced exactly; the shell runs the same Git command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fallback {
    /// A reftable repository: `gix` reads the file backend only.
    Reftable,
    /// `refs/replace`: Git maps objects through replacements and `gix` does not.
    Replace,
    /// `info/grafts`: Git rewrites ancestry and `gix` does not.
    Grafts,
    /// A shallow repository: Git bounds ancestry and `gix` does not.
    Shallow,
    /// `core.warnAmbiguousRefs=false` shortens refs by other rules than Git's default.
    AmbiguousRefs,
    /// A prunable worktree, or a lock reason `gix` doesn't word as Git does.
    WorktreeReason,
    /// A repository `gix` cannot open or read; Git decides what that means.
    Unreadable,
    /// The caller's signal aborted the read; the answer is never used.
    Cancelled,
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
            Self::Replace => "replace",
            Self::Grafts => "grafts",
            Self::Shallow => "shallow",
            Self::AmbiguousRefs => "ambiguous_refs",
            Self::WorktreeReason => "worktree_reason",
            Self::Unreadable => "unreadable",
            Self::Cancelled => "cancelled",
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

/// Cooperative cancellation of a read: the binding's abort token, polled in long walks so a
/// cancelled call stops instead of holding a worker thread to the end.
#[derive(Clone, Default)]
pub struct Cancel {
    flag: Option<Arc<AtomicBool>>,
}

impl Cancel {
    /// A cancel token the binding aborts from the JavaScript thread.
    pub fn new(flag: Arc<AtomicBool>) -> Self {
        Self { flag: Some(flag) }
    }

    /// A read no caller can cancel, for tests and callers without a signal.
    pub fn never() -> Self {
        Self::default()
    }

    /// Whether the caller has aborted this read.
    pub fn aborted(&self) -> bool {
        self.flag
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
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
pub fn resolve_commit(root: &str, reference: &str, cancel: &Cancel) -> Outcome<CommitResolution> {
    let Some(repo) = open(root) else {
        return Outcome::fallback(Fallback::Unreadable);
    };
    if reftable(&repo) {
        return Outcome::fallback(Fallback::Reftable);
    }
    if let Some(reason) = object_view(&repo, cancel) {
        return Outcome::fallback(reason);
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
pub fn branch_head(root: &str, reference: &str, cancel: &Cancel) -> Outcome<Option<String>> {
    if cancel.aborted() {
        return Outcome::fallback(Fallback::Cancelled);
    }
    let Some(repo) = open(root) else {
        return Outcome::fallback(Fallback::Unreadable);
    };
    if reftable(&repo) {
        return Outcome::fallback(Fallback::Reftable);
    }
    if let Some(reason) = object_view(&repo, cancel) {
        return Outcome::fallback(reason);
    }
    let commit = repo
        .find_reference(reference)
        .ok()
        .and_then(|mut found| found.peel_to_kind(gix::object::Kind::Commit).ok())
        .map(|object| object.id);
    Outcome::data(commit.map(|id| id.to_string()))
}

/// `for-each-ref`'s lines for `remote-branches.ts`'s format, in its sort order, with `--count`.
pub fn branch_refs(
    root: &str,
    patterns: &[String],
    count: u32,
    cancel: &Cancel,
) -> Outcome<Vec<u8>> {
    let Some(repo) = open(root) else {
        return Outcome::fallback(Fallback::Unreadable);
    };
    if reftable(&repo) {
        return Outcome::fallback(Fallback::Reftable);
    }
    if ambiguous_shortening(&repo) {
        return Outcome::fallback(Fallback::AmbiguousRefs);
    }
    if let Some(reason) = object_view(&repo, cancel) {
        return Outcome::fallback(reason);
    }
    match listing::branch_refs(&repo, patterns, count, cancel) {
        Some(lines) => Outcome::data(lines),
        None if cancel.aborted() => Outcome::fallback(Fallback::Cancelled),
        None => Outcome::fallback(Fallback::Unreadable),
    }
}

/// `for-each-ref`'s `%(refname:short)` lines, in ref name order, with `--count`.
pub fn branch_names(
    root: &str,
    patterns: &[String],
    count: u32,
    cancel: &Cancel,
) -> Outcome<Vec<u8>> {
    let Some(repo) = open(root) else {
        return Outcome::fallback(Fallback::Unreadable);
    };
    if reftable(&repo) {
        return Outcome::fallback(Fallback::Reftable);
    }
    if ambiguous_shortening(&repo) {
        return Outcome::fallback(Fallback::AmbiguousRefs);
    }
    match listing::branch_names(&repo, patterns, count, cancel) {
        Some(lines) => Outcome::data(lines),
        None if cancel.aborted() => Outcome::fallback(Fallback::Cancelled),
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

/// A repository feature that changes which object or ancestry Git reads: replacements,
/// grafts and shallow boundaries. `gix` reads the objects as stored, so such a repository
/// defers every read whose answer those features could change.
pub(crate) fn object_view(repo: &gix::Repository, cancel: &Cancel) -> Option<Fallback> {
    if cancel.aborted() {
        return Some(Fallback::Cancelled);
    }
    match repo.is_shallow() {
        Ok(true) => return Some(Fallback::Shallow),
        Ok(false) => {}
        Err(_) => return Some(Fallback::Unreadable),
    }
    if std::fs::metadata(repo.common_dir().join("info/grafts")).is_ok_and(|grafts| grafts.len() > 0)
    {
        return Some(Fallback::Grafts);
    }
    // Any ref under `refs/replace` maps objects for Git; the iterator reads no objects.
    let Ok(platform) = repo.references() else {
        // A ref store that cannot be read is Git's to word, and may hold a replacement.
        return Some(Fallback::Unreadable);
    };
    match platform.prefixed("refs/replace") {
        Ok(mut replacing) => replacing.next().is_some().then_some(Fallback::Replace),
        Err(_) => Some(Fallback::Unreadable),
    }
}

/// `core.warnAmbiguousRefs=false`: Git then shortens refs by its loose rules rather than the
/// strict unambiguous one this port implements.
fn ambiguous_shortening(repo: &gix::Repository) -> bool {
    repo.config_snapshot().boolean("core.warnAmbiguousRefs") == Some(false)
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

/// A root ref: a file directly in the Git directory that holds a ref (`ORIG_HEAD`,
/// `FETCH_HEAD`, or any other name Git resolves there). It makes its bare name ambiguous.
pub(crate) fn root_ref(repo: &gix::Repository, name: &BStr) -> bool {
    let name = name.as_bytes();
    if name.is_empty() || name.contains(&b'/') || name.contains(&b'\\') {
        return false;
    }
    root_ref_file(repo, name)
}

#[cfg(unix)]
fn root_ref_file(repo: &gix::Repository, name: &[u8]) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::OsStr::from_bytes(name);
    reads_ref(&repo.git_dir().join(name))
}

#[cfg(not(unix))]
fn root_ref_file(repo: &gix::Repository, name: &[u8]) -> bool {
    let name = std::str::from_utf8(name).unwrap_or_default();
    !name.is_empty() && reads_ref(&repo.git_dir().join(name))
}

/// Whether a file's bytes name a ref: an object id, or `ref: <name>`.
fn reads_ref(path: &std::path::Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let first = bytes.split(|byte| *byte == b'\n').next().unwrap_or(&[]);
    let text = first.trim_ascii();
    if let Some(target) = text.strip_prefix(b"ref:") {
        return !trim_ascii(target).is_empty();
    }
    let oid = text
        .split(|byte| byte.is_ascii_whitespace())
        .next()
        .unwrap_or(&[]);
    (oid.len() == 40 || oid.len() == 64) && oid.iter().all(u8::is_ascii_hexdigit)
}

/// Trim ASCII whitespace, including the vertical tab C's `isspace` counts and
/// `u8::is_ascii_whitespace` does not.
pub(crate) fn trim_ascii(bytes: &[u8]) -> &[u8] {
    let is_space = |byte: &u8| byte.is_ascii_whitespace() || *byte == 0x0b;
    let start = bytes
        .iter()
        .position(|byte| !is_space(byte))
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| !is_space(byte))
        .map_or(start, |at| at + 1);
    &bytes[start..end]
}

#[cfg(test)]
mod tests {
    use super::{Cancel, Fallback, Outcome};
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
            crate::worktrees_gix::worktrees(&root, &Cancel::never()),
            Outcome::Fallback(Fallback::Reftable)
        ));
        assert!(matches!(
            super::branch_refs(&root, &["refs/heads".to_owned()], 0, &Cancel::never()),
            Outcome::Fallback(Fallback::Reftable)
        ));
        assert!(matches!(
            super::resolve_commit(&root, "HEAD", &Cancel::never()),
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
            crate::worktrees_gix::worktrees(&root(&scratch), &Cancel::never()),
            Outcome::Fallback(Fallback::WorktreeReason)
        ));
        Ok(())
    }

    /// Git maps objects through `refs/replace`, grafts and shallow boundaries; `gix` reads the
    /// stored objects, so those repositories defer.
    #[test]
    fn a_replaced_grafted_or_shallow_repository_defers_the_object_reads_to_git()
    -> Result<(), Box<dyn std::error::Error>> {
        let scratch = Scratch::new()?;
        repository(&scratch)?;
        let root = root(&scratch);
        scratch.write(
            "refs/replace/0123456789012345678901234567890123456789",
            "1111111111111111111111111111111111111111\n",
        )?;
        assert!(matches!(
            super::resolve_commit(&root, "HEAD", &Cancel::never()),
            Outcome::Fallback(Fallback::Replace)
        ));
        assert!(matches!(
            super::branch_head(&root, "refs/heads/main", &Cancel::never()),
            Outcome::Fallback(Fallback::Replace)
        ));
        assert!(matches!(
            super::branch_refs(&root, &["refs/heads".to_owned()], 0, &Cancel::never()),
            Outcome::Fallback(Fallback::Replace)
        ));
        std::fs::remove_dir_all(scratch.git().join("refs/replace"))?;
        scratch.write("info/grafts", "1111111111111111111111111111111111111111\n")?;
        assert!(matches!(
            super::branch_head(&root, "refs/heads/main", &Cancel::never()),
            Outcome::Fallback(Fallback::Grafts)
        ));
        std::fs::remove_file(scratch.git().join("info/grafts"))?;
        scratch.write("shallow", "1111111111111111111111111111111111111111\n")?;
        assert!(matches!(
            super::resolve_commit(&root, "HEAD", &Cancel::never()),
            Outcome::Fallback(Fallback::Shallow)
        ));
        Ok(())
    }

    /// Loose shortening (`core.warnAmbiguousRefs=false`) uses other rules than Git's default.
    #[test]
    fn loose_ambiguous_refs_defer_the_short_names_to_git() -> Result<(), Box<dyn std::error::Error>>
    {
        let scratch = Scratch::new()?;
        repository(&scratch)?;
        scratch.write(
            "config",
            "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\twarnAmbiguousRefs = false\n",
        )?;
        let root = root(&scratch);
        assert!(matches!(
            super::branch_names(&root, &["refs/heads".to_owned()], 0, &Cancel::never()),
            Outcome::Fallback(Fallback::AmbiguousRefs)
        ));
        Ok(())
    }

    /// An aborted read stops before it opens the repository.
    #[test]
    fn an_aborted_read_reports_cancelled() -> Result<(), Box<dyn std::error::Error>> {
        let scratch = Scratch::new()?;
        repository(&scratch)?;
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let cancel = Cancel::new(flag);
        assert!(matches!(
            super::branch_head(&root(&scratch), "refs/heads/main", &cancel),
            Outcome::Fallback(Fallback::Cancelled)
        ));
        Ok(())
    }
}
