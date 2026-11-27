//! Worktree facts the checkpoint, cleanup and suggestion paths read
//! (`linked-worktrees.ts`, `worktree-footprint.ts`, `missing-worktrees.ts`, G3a).
//! `forgetMissing` stays with the write items: it removes a registration.
//!
//! Proof: `worktrees.process`, `worktree-cleanup.process`, `nested.process` and
//! `checkout-paths.process`.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use ace_json::{Array, Number, Value};

use crate::core::error::{GitError, GitErrorCode};
use crate::core::lease::journal::{metadata_directory, text};
use crate::core::paths;
use crate::parse::repository::Worktree;

/// Traversal budget for a cold cleanup scan.
pub const FOOTPRINT_ENTRIES: usize = 10_000;
/// Maximum depth the scan follows.
pub const FOOTPRINT_DEPTH: usize = 32;

/// What a cold cleanup measures: bytes, the newest mtime and a digest of the stat facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Footprint {
    pub bytes: u64,
    pub modified_at: i64,
    pub digest: String,
}

/// The shared metadata directory of the repository a checkout belongs to, read without Git.
fn common_directory(root: &str) -> Option<String> {
    let metadata = metadata_directory(root).ok()??;
    // A main checkout has no `commondir`; a linked one names the shared directory.
    let common = text(&Path::new(&metadata).join("commondir")).ok().flatten();
    let target = match common {
        Some(common) if !common.is_empty() => {
            paths::resolve(&metadata, paths::strip_terminator(&common, false))
        }
        _ => metadata,
    };
    paths::canonical(&target).ok()
}

/// Of `paths` (relative to `root`, each with its own `.git`), the linked worktrees of this
/// repository: other checkouts of this history, never nested repositories.
pub fn same_repository_worktrees(
    root: &str,
    paths: &[String],
) -> Result<HashSet<String>, GitError> {
    let mut linked: HashSet<String> = HashSet::new();
    if paths.is_empty() {
        return Ok(linked);
    }
    let Some(own) = common_directory(root) else {
        return Ok(linked);
    };
    for path in paths {
        let checkout = Path::new(root).join(path);
        // A `.git` directory is a repository of its own; only `.git` files link worktrees.
        let Ok(metadata) = std::fs::symlink_metadata(checkout.join(".git")) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if common_directory(&checkout.to_string_lossy()).is_some_and(|common| common == own) {
            linked.insert(path.clone());
        }
    }
    Ok(linked)
}

fn absent(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ENOTDIR)
}

fn footprint_error() -> GitError {
    GitError::new(
        GitErrorCode::OutputTooLarge,
        "Worktree cleanup scan exceeds its budget",
    )
}

fn directory_error() -> GitError {
    GitError::new(
        GitErrorCode::OutputTooLarge,
        "Worktree directory exceeds its budget",
    )
}

fn stat_value(metadata: &std::fs::Metadata, path: &str) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let mtime_ms =
            metadata.mtime() as f64 * 1000.0 + metadata.mtime_nsec() as f64 / 1_000_000.0;
        let ctime_ms =
            metadata.ctime() as f64 * 1000.0 + metadata.ctime_nsec() as f64 / 1_000_000.0;
        let value = Value::Array(Array::from(vec![
            Value::from(path),
            Value::Number(Number::from(metadata.dev())),
            Value::Number(Number::from(metadata.ino())),
            Value::Number(Number::from(metadata.size())),
            Value::Number(Number::from(mtime_ms)),
            Value::Number(Number::from(ctime_ms)),
        ]));
        ace_json::to_string(&value)
    }
    #[cfg(not(unix))]
    {
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0);
        let value = Value::Array(Array::from(vec![
            Value::from(path),
            Value::Number(Number::from(metadata.len())),
            Value::Number(Number::from(mtime_ms)),
        ]));
        ace_json::to_string(&value)
    }
}

fn newest_mtime_ms(metadata: &std::fs::Metadata) -> i64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let ms = metadata.mtime() as f64 * 1000.0 + metadata.mtime_nsec() as f64 / 1_000_000.0;
        ms.floor() as i64
    }
    #[cfg(not(unix))]
    {
        metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
            .floor() as i64
    }
}

/// Directory entries in the TypeScript's order: `toSorted()` compares UTF-16 code units, so an
/// astral name sorts before `U+FF5E` where UTF-8 bytes would put it after.
fn traversal_order(names: &mut [String]) {
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
}

/// Cold cleanup only. Bound traversal; symlinks contribute their own bytes, never target bytes.
pub fn worktree_footprint(root: &str) -> Result<Footprint, GitError> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    let visited = AtomicUsize::new(0);
    let mut bytes = 0u64;
    let mut modified_at = 0i64;
    fn walk(
        path: &Path,
        depth: usize,
        hash: &mut Sha256,
        visited: &AtomicUsize,
        bytes: &mut u64,
        modified_at: &mut i64,
    ) -> Result<(), GitError> {
        if visited.fetch_add(1, Ordering::Relaxed) + 1 > FOOTPRINT_ENTRIES
            || depth > FOOTPRINT_DEPTH
        {
            return Err(footprint_error());
        }
        let metadata =
            std::fs::symlink_metadata(path).map_err(|error| GitError::from_io(&error))?;
        hash.update(stat_value(&metadata, &path.to_string_lossy()));
        *modified_at = (*modified_at).max(newest_mtime_ms(&metadata));
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            let mut read_dir =
                std::fs::read_dir(path).map_err(|error| GitError::from_io(&error))?;
            let mut names: Vec<String> = Vec::new();
            while let Some(entry) = read_dir
                .next()
                .transpose()
                .map_err(|error| GitError::from_io(&error))?
            {
                // The TypeScript checks before pushing each entry, so 10,001 names pass and the
                // 10,002nd refuses.
                if names.len() > FOOTPRINT_ENTRIES {
                    return Err(directory_error());
                }
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
            traversal_order(&mut names);
            for name in names {
                walk(
                    &path.join(name),
                    depth + 1,
                    hash,
                    visited,
                    bytes,
                    modified_at,
                )?;
            }
        } else {
            *bytes += metadata.len();
        }
        Ok(())
    }
    walk(
        Path::new(root),
        0,
        &mut hash,
        &visited,
        &mut bytes,
        &mut modified_at,
    )?;
    Ok(Footprint {
        bytes,
        modified_at,
        digest: format!("{:x}", hash.finalize()),
    })
}

/// A path with its existing ancestors' aliases resolved, even if it is gone.
pub fn physical(path: &str) -> Result<String, GitError> {
    if Path::new(path).is_absolute() {
        return physical_absolute(path);
    }
    let cwd = std::env::current_dir().map_err(|error| GitError::from_io(&error))?;
    physical_absolute(&paths::resolve(&cwd.to_string_lossy(), path))
}

fn physical_absolute(absolute: &str) -> Result<String, GitError> {
    match paths::canonical(absolute) {
        Ok(real) => Ok(real),
        Err(error) if absent(&error) => {
            let path = Path::new(absolute);
            let Some(parent) = path.parent() else {
                return Ok(absolute.to_owned());
            };
            if parent == path {
                return Ok(absolute.to_owned());
            }
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            Ok(Path::new(&physical_absolute(&parent.to_string_lossy())?)
                .join(name)
                .to_string_lossy()
                .into_owned())
        }
        Err(error) => Err(GitError::from_io(&error)),
    }
}

/// A registered worktree whose folder was deleted by hand. Git marks it `prunable`; ace checks
/// the folder itself too, so damaged metadata with a real folder is never treated as gone.
pub fn is_missing(tree: &Worktree) -> Result<bool, GitError> {
    if tree.prunable.is_none() || tree.bare {
        return Ok(false);
    }
    match std::fs::symlink_metadata(&tree.path) {
        Ok(_) => Ok(false),
        Err(error) if absent(&error) => Ok(true),
        Err(error) => Err(GitError::from_io(&error)),
    }
}

/// The registered, missing worktree at `path`, and whether it is the main worktree.
pub fn find_missing(trees: &[Worktree], path: &str) -> Result<Option<(Worktree, bool)>, GitError> {
    let wanted = physical(path)?;
    for (index, tree) in trees.iter().enumerate() {
        if physical(&tree.path)? != wanted {
            continue;
        }
        return Ok(if is_missing(tree)? {
            Some((tree.clone(), index == 0))
        } else {
            None
        });
    }
    Ok(None)
}

/// Missing registrations that would block a new worktree at `path` or on `branch`.
pub fn missing_blockers(
    trees: &[Worktree],
    path: &str,
    branch: &str,
) -> Result<Vec<Worktree>, GitError> {
    let wanted = physical(path)?;
    let mut blockers = Vec::new();
    for tree in trees.iter().skip(1) {
        if tree.branch.as_deref() != Some(branch) && physical(&tree.path)? != wanted {
            continue;
        }
        if is_missing(tree)? {
            blockers.push(tree.clone());
        }
    }
    Ok(blockers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    #[tokio::test]
    async fn only_this_repositorys_linked_worktrees_are_linked() {
        let fixture = Fixture::new("g3a-linked");
        let repo = fixture.repository("repo");
        let linked = fixture.root.join("linked");
        fixture.git(
            &repo,
            &[
                "worktree",
                "add",
                "--quiet",
                &linked.to_string_lossy(),
                "-b",
                "linked",
            ],
        );
        let nested = repo.join("nested");
        std::fs::create_dir_all(&nested).expect("nested");
        fixture.git(&nested, &["init", "--quiet"]);
        let other = fixture.root.join("other");
        std::fs::create_dir_all(&other).expect("other");
        fixture.git(&other, &["init", "--quiet"]);

        let found = same_repository_worktrees(
            &repo.to_string_lossy(),
            &[
                "../linked".to_owned(),
                "nested".to_owned(),
                "../other".to_owned(),
            ],
        )
        .expect("linked");
        assert_eq!(found, HashSet::from(["../linked".to_owned()]));
    }

    #[test]
    fn a_footprint_is_stable_and_counts_files_and_links_not_their_targets() {
        let fixture = Fixture::new("g3a-footprint");
        let root = fixture.root.join("tree");
        std::fs::create_dir_all(root.join("sub")).expect("tree");
        std::fs::write(root.join("a.txt"), b"hello").expect("a");
        std::fs::write(root.join("sub/b.txt"), b"").expect("b");
        #[cfg(unix)]
        std::os::unix::fs::symlink("/nowhere", root.join("link")).expect("link");
        let first = worktree_footprint(&root.to_string_lossy()).expect("footprint");
        let second = worktree_footprint(&root.to_string_lossy()).expect("again");
        assert_eq!(first, second);
        // The symlink contributes its target string (8) and the two files 5.
        assert_eq!(first.bytes, 13);
        assert_eq!(first.digest.len(), 64);
        assert!(first.modified_at > 0);
        // One more file changes the digest, the byte count and never the depth.
        std::fs::write(root.join("sub/c.txt"), b"123").expect("c");
        let third = worktree_footprint(&root.to_string_lossy()).expect("third");
        assert_ne!(third.digest, first.digest);
        assert_eq!(third.bytes, 16);
    }

    #[test]
    fn a_directory_caps_its_listing_at_10002_names_not_at_its_visit_budget() {
        let fixture = Fixture::new("g3a-dir-cap");
        // 10,001 names are listed; the scan's own visit budget then refuses the walk.
        let allowed = fixture.root.join("many");
        std::fs::create_dir_all(&allowed).expect("dir");
        for index in 0..10_001 {
            std::fs::create_dir(allowed.join(format!("{index:05}"))).expect("entry");
        }
        let visited = worktree_footprint(&allowed.to_string_lossy())
            .expect_err("the walk visits more than its budget");
        assert_eq!(visited.message, "Worktree cleanup scan exceeds its budget");
        // The 10,002nd name refuses the listing itself.
        let refused = fixture.root.join("too-many");
        std::fs::create_dir_all(&refused).expect("dir");
        for index in 0..10_002 {
            std::fs::create_dir(refused.join(format!("{index:05}"))).expect("entry");
        }
        let listed = worktree_footprint(&refused.to_string_lossy()).expect_err("listing cap");
        assert_eq!(listed.message, "Worktree directory exceeds its budget");
    }

    #[test]
    fn the_traversal_order_compares_utf16_code_units() {
        // `U+1F600` is `D83D DE00` in UTF-16, before `U+FF5E`; UTF-8 bytes would order them the
        // other way (`EF BD 9E` < `F0 9F 98 80`).
        let mut names = vec!["\u{FF5E}".to_owned(), "\u{1F600}".to_owned()];
        traversal_order(&mut names);
        assert_eq!(names, vec!["\u{1F600}".to_owned(), "\u{FF5E}".to_owned()]);
    }

    #[test]
    fn the_newest_modification_is_floored_milliseconds() {
        let fixture = Fixture::new("g3a-mtime");
        let root = fixture.root.join("stamped");
        std::fs::create_dir_all(&root).expect("dir");
        let file = root.join("a.txt");
        std::fs::write(&file, b"x").expect("file");
        let stamp = std::time::UNIX_EPOCH + std::time::Duration::new(1_700_000_000, 123_456_789);
        std::fs::File::options()
            .write(true)
            .open(&file)
            .expect("open")
            .set_modified(stamp)
            .expect("set the file's mtime");
        std::fs::File::open(&root)
            .expect("open the directory")
            .set_modified(stamp)
            .expect("set the directory's mtime");
        let footprint = worktree_footprint(&root.to_string_lossy()).expect("footprint");
        // `Math.floor(info.mtimeMs)`: milliseconds, the fraction dropped, never seconds.
        assert_eq!(footprint.modified_at, 1_700_000_000_123);
    }

    #[test]
    fn a_scan_deeper_than_its_budget_is_refused() {
        let fixture = Fixture::new("g3a-depth");
        let mut path = fixture.root.join("deep");
        std::fs::create_dir_all(&path).expect("deep");
        for _ in 0..=FOOTPRINT_DEPTH {
            path = path.join("d");
            std::fs::create_dir_all(&path).expect("level");
        }
        let error = worktree_footprint(&fixture.root.to_string_lossy()).expect_err("budget");
        assert_eq!(error.code, GitErrorCode::OutputTooLarge);
    }

    #[tokio::test]
    async fn a_worktree_deleted_by_hand_is_missing_and_blocks_its_branch() {
        let fixture = Fixture::new("g3a-missing");
        let repo = fixture.repository("repo");
        let linked = fixture.root.join("gone");
        fixture.git(
            &repo,
            &[
                "worktree",
                "add",
                "--quiet",
                &linked.to_string_lossy(),
                "-b",
                "gone",
            ],
        );
        std::fs::remove_dir_all(&linked).expect("remove");
        let port = ProcessCommands { fixture: &fixture };
        let trees = crate::reads::info::worktrees(&port, &repo.to_string_lossy(), false)
            .await
            .expect("worktrees");
        let missing = find_missing(&trees, &linked.to_string_lossy())
            .expect("find")
            .expect("missing");
        assert!(!missing.1);
        assert_eq!(missing.0.branch.as_deref(), Some("gone"));
        assert_eq!(
            missing_blockers(&trees, &linked.to_string_lossy(), "gone")
                .expect("blockers")
                .len(),
            1
        );
        assert!(
            missing_blockers(&trees, "/elsewhere", "other")
                .expect("blockers")
                .is_empty()
        );
    }

    #[test]
    fn a_physical_path_keeps_the_aliases_of_its_existing_ancestors() {
        let fixture = Fixture::new("g3a-physical");
        let real = fixture.root.join("real");
        std::fs::create_dir_all(&real).expect("real");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, fixture.root.join("link")).expect("symlink");
        #[cfg(unix)]
        let resolved =
            physical(&fixture.root.join("link/absent").to_string_lossy()).expect("physical");
        #[cfg(unix)]
        assert_eq!(
            resolved,
            format!(
                "{}/absent",
                paths::canonical(&real.to_string_lossy()).expect("canonical")
            )
        );
        let _ = physical(&real.to_string_lossy());
    }
}
