// SPDX-License-Identifier: Apache-2.0
//! Which files can change what a Git command reads as configuration, and
//! when one of their stamps is trustworthy (`packages/git/src/config-sources.ts`
//! and the stamp half of `config-facts.ts`, G2c).
//!
//! Nothing here launches Git: the caller passes the raw `rev-parse` and
//! `config --list` output, exactly as TypeScript hands it to the parsers.

use std::path::{Path, PathBuf};

use ace_json::{Array, JsString, Map, Value};

use crate::core::error::{GitError, GitErrorCode};

/// A file changed this recently may change again within the filesystem's
/// timestamp granularity without its stamp moving, so a snapshot is trusted
/// only once every source is older than this.
pub const SETTLE_MS: i64 = 2_000;
/// Cached checkouts (and settling windows) kept before the oldest is dropped.
pub const CAPACITY: usize = 256;

/// Environment that never changes what Git reads as configuration or which checkout it finds.
pub const CONFIG_NEUTRAL: &[&str] = &[
    "GIT_INDEX_FILE",
    "GIT_LITERAL_PATHSPECS",
    "GIT_OPTIONAL_LOCKS",
    "GIT_TERMINAL_PROMPT",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
];

/// The part of a call's environment that can change Git's configuration sources, sorted by key
/// so it forms a stable cache key.
pub fn config_environment(env: &[(String, String)]) -> Vec<(String, String)> {
    let mut kept: Vec<(String, String)> = env
        .iter()
        .filter(|(key, _)| !CONFIG_NEUTRAL.contains(&key.as_str()))
        .cloned()
        .collect();
    kept.sort_by(|(left, _), (right, _)| left.cmp(right));
    kept
}

/// Where a checkout's Git metadata lives, from three single-value `rev-parse` queries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub git_dir: String,
    pub common_dir: String,
    pub toplevel: String,
}

/// One path value from Git: strip one LF terminator (CRLF only on Windows).
pub fn single(raw: &str, is_windows: bool) -> String {
    crate::core::paths::strip_terminator(raw, is_windows).to_owned()
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `path.resolve(dir, value)`: absolute values stay, relative ones join.
pub(crate) fn resolve_path(base: &str, value: &str) -> String {
    let joined = Path::new(base).join(value);
    crate::core::paths::normalise(&joined)
}

pub fn parse_layout(cwd: &str, git_dir: &str, common_dir: &str, toplevel: &str) -> Option<Layout> {
    if git_dir.is_empty() || common_dir.is_empty() || toplevel.is_empty() {
        return None;
    }
    if !Path::new(git_dir).is_absolute() || !Path::new(toplevel).is_absolute() {
        return None;
    }
    Some(Layout {
        git_dir: git_dir.to_owned(),
        common_dir: resolve_path(cwd, common_dir),
        toplevel: toplevel.to_owned(),
    })
}

fn include_target(value: &str, file: &str, home: Option<&str>) -> Option<String> {
    if value.is_empty() {
        return Some(String::new());
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home
            .filter(|home| Path::new(home).is_absolute())
            .map(|home| display(&Path::new(home).join(rest)));
    }
    // `~user/` and `%(prefix)/` depend on the account database and Git's build.
    if value.starts_with('~') || value.starts_with("%(prefix)") {
        return None;
    }
    if Path::new(value).is_absolute() {
        return Some(value.to_owned());
    }
    let parent = display(Path::new(file).parent().unwrap_or(Path::new("")));
    Some(resolve_path(&parent, value))
}

fn is_include_path(key: &str) -> bool {
    static PATTERN: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| regex::Regex::new(r"(?s)^include(?:if\..*)?\.path$").ok())
        .as_ref()
        .is_some_and(|pattern| pattern.is_match(key))
}

/// Every file the `config -z --show-origin --show-scope --list` output says Git read, plus the
/// targets of every include directive in them, whether or not those exist yet. `None` when the
/// listing has an origin or include this module can't place on disk exactly as Git would.
pub fn listed_sources(listing: &str, layout: &Layout, home: Option<&str>) -> Option<Vec<String>> {
    if !listing.is_empty() && !listing.ends_with('\0') {
        return None;
    }
    let fields: Vec<&str> = if listing.is_empty() {
        Vec::new()
    } else {
        listing[..listing.len() - 1].split('\0').collect()
    };
    if !fields.len().is_multiple_of(3) {
        return None;
    }
    let repository_files = [
        display(&Path::new(&layout.common_dir).join("config")),
        display(&Path::new(&layout.git_dir).join("config.worktree")),
    ];
    let mut files: Vec<String> = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let scope = fields[index];
        let origin = fields.get(index + 1).copied()?;
        let entry = fields.get(index + 2).copied()?;
        index += 3;
        // Our own `-c`/GIT_CONFIG_* pairs: fixed by the caller, never a file.
        if scope == "command" {
            continue;
        }
        let named = origin.strip_prefix("file:")?;
        // Git names the repository's own files relative to the worktree it changed into.
        let file = if Path::new(named).is_absolute() {
            named.to_owned()
        } else {
            let resolved = resolve_path(&layout.toplevel, named);
            if !repository_files.contains(&resolved) {
                return None;
            }
            resolved
        };
        push_unique(&mut files, &file);
        let newline = entry.find('\n');
        let key = match newline {
            Some(at) => &entry[..at],
            None => entry,
        };
        if !is_include_path(&key.to_lowercase()) {
            continue;
        }
        let value = match newline {
            Some(at) => &entry[at + 1..],
            None => "",
        };
        let target = include_target(value, &file, home)?;
        if !target.is_empty() {
            push_unique(&mut files, &target);
        }
    }
    Some(files)
}

fn push_unique(items: &mut Vec<String>, value: &str) {
    if !items.iter().any(|item| item == value) {
        items.push(value.to_owned());
    }
}

/// Every file whose change can alter what a Git command in `cwd` reads as configuration or which
/// checkout it finds: each listed file and include target, the standard files even when absent,
/// the checkout's own config files, HEAD (for `includeIf.onbranch`) and, from `cwd` up to its
/// worktree root, every `.git` entry and bare-repository marker.
pub fn watched_paths(
    cwd: &str,
    layout: &Layout,
    listed: &[String],
    standard: &[String],
) -> Option<Vec<String>> {
    let toplevel = Path::new(&layout.toplevel);
    // A path outside the checkout root has no discovery walk from the root.
    Path::new(cwd).strip_prefix(toplevel).ok()?;
    let mut discovery: Vec<String> = Vec::new();
    let mut directory = PathBuf::from(cwd);
    loop {
        discovery.push(display(&directory.join(".git")));
        if directory == *toplevel {
            break;
        }
        // Without a `.git` entry, discovery also accepts the directory itself as a bare
        // repository once it holds HEAD, objects/ and refs/, and then reads its `config`.
        for part in ["HEAD", "objects", "refs", "config"] {
            discovery.push(display(&directory.join(part)));
        }
        let parent = directory.parent()?.to_path_buf();
        if parent == directory || !starts_with_path(&directory, toplevel) {
            return None;
        }
        directory = parent;
    }
    let mut watched: Vec<String> = Vec::new();
    for path in discovery
        .into_iter()
        .chain([
            display(&Path::new(&layout.git_dir).join("HEAD")),
            display(&Path::new(&layout.git_dir).join("commondir")),
            display(&Path::new(&layout.git_dir).join("gitdir")),
            display(&Path::new(&layout.git_dir).join("config.worktree")),
            display(&Path::new(&layout.common_dir).join("config")),
        ])
        .chain(standard.iter().cloned())
        .chain(listed.iter().cloned())
    {
        if !watched.contains(&path) {
            watched.push(path);
        }
    }
    Some(watched)
}

fn starts_with_path(path: &Path, prefix: &Path) -> bool {
    path.strip_prefix(prefix).is_ok() && path != prefix
}

/// One stamped source list: a stable string over every file's identity and times, plus the
/// newest mtime/ctime seen, which decides whether the sources are still settling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub stamp: String,
    pub newest_ms: i64,
}

/// Stamps `paths`, or `None` when a path exists but cannot be read. A directory contributes its
/// identity only: its times move with every lock file inside it.
pub fn stamp_of(paths: &[String]) -> Option<Stamp> {
    let mut newest = 0i64;
    let mut parts: Vec<String> = Vec::with_capacity(paths.len());
    for path in paths {
        let info = match std::fs::symlink_metadata(path) {
            Ok(info) => info,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                parts.push("-".to_owned());
                continue;
            }
            Err(error) => {
                // ENOTDIR: a parent that used to be a directory is a file now.
                if error.raw_os_error() == Some(libc::ENOTDIR) {
                    parts.push("-".to_owned());
                    continue;
                }
                return None;
            }
        };
        if info.is_dir() {
            parts.push(format!("d:{}", identity(&info)));
            continue;
        }
        let (mtime, ctime) = times(&info);
        newest = newest.max(mtime).max(ctime);
        parts.push(format!(
            "f:{}:{}:{mtime}:{ctime}",
            identity(&info),
            info.len()
        ));
    }
    Some(Stamp {
        stamp: parts.join("\0"),
        newest_ms: newest,
    })
}

#[cfg(unix)]
fn identity(info: &std::fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}:{:o}", info.dev(), info.ino(), info.mode())
}

#[cfg(not(unix))]
fn identity(info: &std::fs::Metadata) -> String {
    use std::time::UNIX_EPOCH;
    let created = info
        .created()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_nanos())
        .unwrap_or(0);
    format!("0:0:{:o}:{created}", info.permissions().readonly() as u8)
}

#[cfg(unix)]
fn times(info: &std::fs::Metadata) -> (i64, i64) {
    use std::os::unix::fs::MetadataExt;
    let ms = |seconds: i64, nanos: i64| {
        seconds
            .saturating_mul(1_000)
            .saturating_add(nanos / 1_000_000)
    };
    (
        ms(info.mtime(), info.mtime_nsec()),
        ms(info.ctime(), info.ctime_nsec()),
    )
}

#[cfg(not(unix))]
fn times(info: &std::fs::Metadata) -> (i64, i64) {
    use std::time::UNIX_EPOCH;
    let ms = |time: std::io::Result<std::time::SystemTime>| {
        time.ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_millis() as i64)
            .unwrap_or(0)
    };
    (ms(info.modified()), ms(info.created()))
}

/// Everything the one `configWatch` operation needs: the raw Git output plus how to read it.
#[derive(Debug, Clone, Default)]
pub struct WatchInput {
    pub cwd: String,
    pub git_dir: Option<String>,
    pub common_dir: Option<String>,
    pub toplevel: Option<String>,
    /// The decoded `config -z --show-origin --show-scope --list` text, or `None` when it was
    /// not valid UTF-8.
    pub listing: Option<String>,
    pub standard: Vec<String>,
    pub home: Option<String>,
    pub is_windows: bool,
}

impl WatchInput {
    /// The watched paths, or `None` whenever any of it can't be named exactly.
    pub fn watched(&self) -> Option<Vec<String>> {
        let (Some(git_dir), Some(common_dir), Some(toplevel), Some(listing)) = (
            self.git_dir.as_deref(),
            self.common_dir.as_deref(),
            self.toplevel.as_deref(),
            self.listing.as_deref(),
        ) else {
            return None;
        };
        let layout = parse_layout(
            &self.cwd,
            &single(git_dir, self.is_windows),
            &single(common_dir, self.is_windows),
            &single(toplevel, self.is_windows),
        )?;
        let listed = listed_sources(listing, &layout, self.home.as_deref())?;
        watched_paths(&self.cwd, &layout, &listed, &self.standard)
    }
}

/// Reads one `configWatch` frame.
pub fn watch_input_from_json(text: &str) -> Option<WatchInput> {
    let map = ace_json::parse(text).ok()?;
    let Value::Object(map) = map else {
        return None;
    };
    let string = |key: &str| match map.get(key) {
        Some(Value::String(value)) => Some(value.to_string_lossy().into_owned()),
        _ => None,
    };
    let flag = |key: &str| matches!(map.get(key), Some(Value::Bool(true)));
    let standard = match map.get("standard") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(value) => Some(value.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect::<Option<Vec<String>>>()?,
        _ => Vec::new(),
    };
    Some(WatchInput {
        cwd: string("cwd")?,
        git_dir: string("gitDir"),
        common_dir: string("commonDir"),
        toplevel: string("toplevel"),
        listing: string("listing"),
        standard,
        home: string("home"),
        is_windows: flag("isWindows"),
    })
}

/// The answer frame: `{ paths: string[] | null }`.
pub fn paths_to_json(paths: Option<&[String]>) -> String {
    let mut frame = Map::new();
    match paths {
        Some(paths) => {
            let items: Vec<Value> = paths
                .iter()
                .map(|path| Value::String(JsString::from(path.as_str())))
                .collect();
            frame.insert(JsString::from("paths"), Value::Array(Array::from(items)));
        }
        None => {
            frame.insert(JsString::from("paths"), Value::Null);
        }
    }
    ace_json::to_string(&Value::Object(frame))
}

/// The error a malformed request is answered with.
pub fn invalid_request() -> GitError {
    GitError::new(GitErrorCode::InvalidArgument, "invalid config request")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> Layout {
        Layout {
            git_dir: "/wt/.git".to_owned(),
            common_dir: "/wt/.git".to_owned(),
            toplevel: "/wt".to_owned(),
        }
    }

    #[test]
    fn a_bare_repository_planted_between_a_subdirectory_and_its_root_is_watched() {
        let watched = watched_paths("/wt/a/b", &layout(), &[], &[]).expect("watched");
        for directory in ["/wt/a/b", "/wt/a"] {
            for part in [".git", "HEAD", "objects", "refs", "config"] {
                let path = format!("{directory}/{part}");
                assert!(watched.contains(&path), "{path} missing");
            }
        }
        // The checkout root is found through its own .git; its HEAD is the worktree's.
        assert!(!watched.contains(&"/wt/objects".to_owned()));
    }

    #[test]
    fn a_directory_outside_its_checkout_root_cannot_be_stamped() {
        assert_eq!(watched_paths("/elsewhere", &layout(), &[], &[]), None);
    }

    #[test]
    fn a_listing_keeps_its_files_and_include_targets_in_order() {
        let listing = "global\0file:/home/u/.gitconfig\0user.name\nu\0\
local\0file:.git/config\0branch.x.merge\nmain\0\
local\0file:.git/config\0include.path\n../shared.inc\0\
local\0file:.git/config\0includeif.onbranch:main.path\n~/team.inc\0";
        let listed = listed_sources(listing, &layout(), Some("/home/u")).expect("listed");
        assert_eq!(
            listed,
            vec![
                "/home/u/.gitconfig".to_owned(),
                "/wt/.git/config".to_owned(),
                "/wt/shared.inc".to_owned(),
                "/home/u/team.inc".to_owned(),
            ]
        );
    }

    #[test]
    fn an_unplaceable_origin_or_include_refuses_the_whole_listing() {
        let cases = [
            // Not a file origin.
            "local\0https://example.invalid/x\0user.name\nu\0",
            // A relative name that is not one of the repository's own files.
            "local\0file:other\0user.name\nu\0",
            // `~user` and `%(prefix)` depend on the account database and Git's build.
            "local\0file:.git/config\0include.path\n~user/x\0",
            "local\0file:.git/config\0include.path\n%(prefix)/x\0",
            // A listing without its final terminator, or with a partial record.
            "local\0file:.git/config\0user.name\nu",
            "local\0file:.git/config\0",
        ];
        for listing in cases {
            assert_eq!(
                listed_sources(listing, &layout(), Some("/home/u")),
                None,
                "{listing}"
            );
        }
        // A `~/` target needs a home directory to name.
        assert_eq!(
            listed_sources(
                "local\0file:.git/config\0include.path\n~/x\0",
                &layout(),
                None
            ),
            None
        );
    }

    #[test]
    fn command_scope_entries_are_ours_and_never_files() {
        let listed = listed_sources(
            "command\0\0core.hooksPath\n/dev/null\0local\0file:.git/config\0user.name\nu\0",
            &layout(),
            None,
        )
        .expect("listed");
        assert_eq!(listed, vec!["/wt/.git/config".to_owned()]);
    }

    #[test]
    fn a_huge_listing_yields_only_its_file_names() {
        // The TypeScript case measures that a kept path does not pin the whole listing
        // (a JS slice of a 512 KB string). Rust copies the two names and keeps nothing of the
        // input, so the same listing parse is asserted once and the retention is structural.
        let filler = format!("branch.x.merge\n{}", "r".repeat(512 * 1024));
        let listing = format!(
            "global\0file:/home/u/.gitconfig\0user.name\nu\0local\0file:.git/config\0{filler}\0"
        );
        for _ in 0..80 {
            assert_eq!(
                listed_sources(&listing, &layout(), Some("/home/u")).expect("listed"),
                vec![
                    "/home/u/.gitconfig".to_owned(),
                    "/wt/.git/config".to_owned()
                ]
            );
        }
    }

    #[test]
    fn a_settled_sources_stamp_keeps_identity_and_times_apart() {
        let directory = std::env::temp_dir().join(format!(
            "ace-g2c-config-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&directory).expect("directory");
        let file = directory.join("config");
        std::fs::write(&file, "[user]\n").expect("file");
        let paths = vec![
            file.to_string_lossy().into_owned(),
            directory.to_string_lossy().into_owned(),
            directory.join("missing").to_string_lossy().into_owned(),
        ];
        let first = stamp_of(&paths).expect("stamped");
        let second = stamp_of(&paths).expect("stamped");
        assert_eq!(first, second);
        assert!(first.newest_ms > 0);
        // A change to the file moves the stamp; a missing path contributes `-`.
        std::fs::write(&file, "[user]\n\tname = x\n").expect("write");
        let third = stamp_of(&paths).expect("stamped");
        assert_ne!(first.stamp, third.stamp);
        assert!(third.stamp.ends_with("\0-"), "{}", third.stamp);
        std::fs::remove_dir_all(&directory).expect("cleanup");
    }

    #[test]
    fn config_environment_drops_neutral_names_and_sorts_the_rest() {
        let env = vec![
            ("GIT_INDEX_FILE".to_owned(), "/tmp/i".to_owned()),
            ("GIT_DIR".to_owned(), "/wt/.git".to_owned()),
            ("HOME".to_owned(), "/home/u".to_owned()),
            ("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned()),
        ];
        assert_eq!(
            config_environment(&env),
            vec![
                ("GIT_DIR".to_owned(), "/wt/.git".to_owned()),
                ("HOME".to_owned(), "/home/u".to_owned()),
            ]
        );
    }

    #[test]
    fn a_single_value_strips_one_terminator_and_crlf_only_on_windows() {
        assert_eq!(single("/wt\n", false), "/wt");
        assert_eq!(single("/wt\n\n", false), "/wt\n");
        assert_eq!(single("C:\\wt\r\n", true), "C:\\wt");
        assert_eq!(single("C:\\wt\r\n", false), "C:\\wt\r");
    }
}

/// The pieces a fact's cache needs from its caller: where the sources are,
/// what to compute, whether the value may be kept, and the clock.
pub trait ConfigPorts: Send + Sync {
    /// The files whose change can alter this checkout's configuration.
    fn sources(
        &self,
        call: u64,
        cwd: &str,
        env_json: &str,
    ) -> crate::core::spawn::BoxFuture<'_, Option<Vec<String>>>;
    /// The fact itself, computed by its owner.
    fn compute(&self, call: u64) -> crate::core::spawn::BoxFuture<'_, Result<Value, GitError>>;
    /// Whether the owner agrees this value may be kept.
    fn keep(&self, call: u64, value: &Value) -> crate::core::spawn::BoxFuture<'_, bool>;
    /// Wall clock in epoch milliseconds, comparable with file timestamps.
    fn now_ms(&self, call: u64) -> crate::core::spawn::BoxFuture<'_, i64>;
}

/// Facts derived only from a checkout's Git configuration and discovery (its
/// root, remotes, configured filter drivers and hooks), kept until any file
/// Git would read them from changes (`ConfigFacts` in `config-facts.ts`).
/// One key's in-flight source learning, which later callers join.
type Flight = std::sync::Arc<tokio::sync::OnceCell<Option<std::sync::Arc<Snapshot>>>>;

pub struct ConfigFacts {
    snapshots: std::sync::Mutex<Snapshots>,
    flights: std::sync::Mutex<std::collections::HashMap<String, Flight>>,
    settling: std::sync::Mutex<std::collections::HashMap<String, i64>>,
    ports: std::sync::Arc<dyn ConfigPorts>,
}

struct Snapshots {
    by_key: std::collections::HashMap<String, std::sync::Arc<Snapshot>>,
    /// Insertion order, oldest first, for eviction.
    order: Vec<String>,
}

struct Snapshot {
    paths: Vec<String>,
    stamp: String,
    values: std::sync::Mutex<std::collections::BTreeMap<String, Value>>,
}

impl ConfigFacts {
    pub fn new(ports: std::sync::Arc<dyn ConfigPorts>) -> Self {
        Self {
            snapshots: std::sync::Mutex::new(Snapshots {
                by_key: std::collections::HashMap::new(),
                order: Vec::new(),
            }),
            flights: std::sync::Mutex::new(std::collections::HashMap::new()),
            settling: std::sync::Mutex::new(std::collections::HashMap::new()),
            ports,
        }
    }

    /// Reads one named fact: a kept value when every source is unchanged,
    /// otherwise `compute`, kept only when the sources are still the same
    /// before and after it and its owner allows it.
    pub async fn read(
        &self,
        call: u64,
        cwd: &str,
        env: &[(String, String)],
        name: &str,
    ) -> Result<Value, GitError> {
        let env_json = env_key(env);
        let key = format!("{cwd}\u{0}{env_json}");
        let (snapshot, checked) = self.snapshot(call, &key).await;
        let Some(snapshot) = snapshot else {
            // Sources are learned only after a computation succeeds, so a failing one never
            // adds more work. The next call can keep a value.
            let value = self.ports.compute(call).await?;
            self.learn_once(call, &key, cwd, &env_json).await;
            return Ok(value);
        };
        let kept = snapshot
            .values
            .lock()
            .ok()
            .and_then(|values| values.get(name).cloned());
        if let Some(kept) = kept {
            // A snapshot learned for another caller was stamped before this call began.
            if !checked
                && stamp_of(&snapshot.paths).map(|stamp| stamp.stamp)
                    != Some(snapshot.stamp.clone())
            {
                return self.ports.compute(call).await;
            }
            return Ok(kept);
        }
        let value = self.ports.compute(call).await?;
        let after = stamp_of(&snapshot.paths);
        let unchanged = after.as_ref().map(|stamp| &stamp.stamp) == Some(&snapshot.stamp);
        if unchanged
            && self.ports.keep(call, &value).await
            && self.is_current(&key, &snapshot)
            && let Ok(mut values) = snapshot.values.lock()
        {
            values.insert(name.to_owned(), value.clone());
        }
        Ok(value)
    }

    /// The checkout's snapshot if its sources are unchanged; one being learned is joined.
    async fn snapshot(&self, _call: u64, key: &str) -> (Option<std::sync::Arc<Snapshot>>, bool) {
        let known = self
            .snapshots
            .lock()
            .ok()
            .and_then(|snapshots| snapshots.by_key.get(key).cloned());
        if let Some(known) = known {
            if stamp_of(&known.paths).map(|stamp| stamp.stamp) == Some(known.stamp.clone()) {
                return (Some(known), true);
            }
            if let Ok(mut snapshots) = self.snapshots.lock()
                && snapshots
                    .by_key
                    .get(key)
                    .is_some_and(|current| std::sync::Arc::ptr_eq(current, &known))
            {
                snapshots.by_key.remove(key);
                snapshots.order.retain(|entry| entry != key);
            }
        }
        let flight = self
            .flights
            .lock()
            .ok()
            .and_then(|flights| flights.get(key).cloned());
        match flight {
            Some(cell) => (cell.get_or_init(|| async { None }).await.clone(), false),
            None => (None, false),
        }
    }

    async fn learn_once(&self, call: u64, key: &str, cwd: &str, env_json: &str) {
        if self
            .snapshots
            .lock()
            .ok()
            .is_some_and(|snapshots| snapshots.by_key.contains_key(key))
        {
            return;
        }
        let existing = self
            .flights
            .lock()
            .ok()
            .and_then(|flights| flights.get(key).cloned());
        if let Some(cell) = existing {
            let _ = cell.get_or_init(|| async { None }).await;
            return;
        }
        // Sources still settling: asking Git again before then can't produce a snapshot either.
        let settling = self
            .settling
            .lock()
            .ok()
            .and_then(|settling| settling.get(key).copied());
        if let Some(until) = settling {
            if self.ports.now_ms(call).await < until {
                return;
            }
            if let Ok(mut settling) = self.settling.lock() {
                settling.remove(key);
            }
        }
        let cell = std::sync::Arc::new(tokio::sync::OnceCell::new());
        if let Ok(mut flights) = self.flights.lock() {
            flights.insert(key.to_owned(), std::sync::Arc::clone(&cell));
        }
        let learned = self.learn(call, key, cwd, env_json).await;
        let _ = cell.set(learned);
        if let Ok(mut flights) = self.flights.lock() {
            flights.remove(key);
        }
    }

    async fn learn(
        &self,
        call: u64,
        key: &str,
        cwd: &str,
        env_json: &str,
    ) -> Option<std::sync::Arc<Snapshot>> {
        let started = self.ports.now_ms(call).await;
        let paths = self.ports.sources(call, cwd, env_json).await?;
        let stamped = stamp_of(&paths)?;
        // Anything written since just before Git listed the sources may hold an include it
        // didn't see, so the snapshot waits for every source to settle.
        if stamped.newest_ms >= started - SETTLE_MS {
            if let Ok(mut settling) = self.settling.lock() {
                settling.insert(key.to_owned(), stamped.newest_ms.max(started) + SETTLE_MS);
                if settling.len() > CAPACITY {
                    settling.clear();
                }
            }
            return None;
        }
        let snapshot = std::sync::Arc::new(Snapshot {
            paths,
            stamp: stamped.stamp,
            values: std::sync::Mutex::new(std::collections::BTreeMap::new()),
        });
        if let Ok(mut snapshots) = self.snapshots.lock() {
            snapshots
                .by_key
                .insert(key.to_owned(), std::sync::Arc::clone(&snapshot));
            snapshots.order.retain(|entry| entry != key);
            snapshots.order.push(key.to_owned());
            while snapshots.by_key.len() > CAPACITY {
                let oldest = snapshots.order.remove(0);
                snapshots.by_key.remove(&oldest);
            }
        }
        Some(snapshot)
    }

    fn is_current(&self, key: &str, snapshot: &std::sync::Arc<Snapshot>) -> bool {
        self.snapshots.lock().ok().is_some_and(|snapshots| {
            snapshots
                .by_key
                .get(key)
                .is_some_and(|current| std::sync::Arc::ptr_eq(current, snapshot))
        })
    }
}

fn env_key(env: &[(String, String)]) -> String {
    let pairs: Vec<Value> = env
        .iter()
        .map(|(key, value)| {
            Value::Array(Array::from(vec![
                Value::String(JsString::from(key.as_str())),
                Value::String(JsString::from(value.as_str())),
            ]))
        })
        .collect();
    ace_json::to_string(&Value::Array(Array::from(pairs)))
}

#[cfg(test)]
mod facts_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    struct FakePorts {
        sources: Mutex<Option<Vec<String>>>,
        computes: AtomicUsize,
        sources_calls: AtomicUsize,
        keep: bool,
        now: i64,
    }

    impl ConfigPorts for FakePorts {
        fn sources(
            &self,
            _call: u64,
            _cwd: &str,
            _env_json: &str,
        ) -> crate::core::spawn::BoxFuture<'_, Option<Vec<String>>> {
            self.sources_calls.fetch_add(1, Ordering::SeqCst);
            let sources = self.sources.lock().ok().and_then(|sources| sources.clone());
            Box::pin(std::future::ready(sources))
        }
        fn compute(
            &self,
            _call: u64,
        ) -> crate::core::spawn::BoxFuture<'_, Result<Value, GitError>> {
            let count = self.computes.fetch_add(1, Ordering::SeqCst) + 1;
            Box::pin(std::future::ready(Ok(Value::from(
                format!("v{count}").as_str(),
            ))))
        }
        fn keep(&self, _call: u64, _value: &Value) -> crate::core::spawn::BoxFuture<'_, bool> {
            Box::pin(std::future::ready(self.keep))
        }
        fn now_ms(&self, _call: u64) -> crate::core::spawn::BoxFuture<'_, i64> {
            Box::pin(std::future::ready(self.now))
        }
    }

    /// The injected clock: an hour ahead, so a test file's ctime (which userspace cannot set)
    /// is already older than the settle window, exactly as a checkout that has been quiet.
    fn fake_now() -> i64 {
        now() + 3_600_000
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis() as i64)
            .unwrap_or(0)
    }

    /// A source file `age_ms` old, so its stamp either has or has not settled.
    fn source(name: &str, age_ms: i64) -> String {
        let path = std::env::temp_dir().join(format!(
            "ace-g2c-facts-{}-{name}-{}",
            std::process::id(),
            now()
        ));
        std::fs::write(&path, "config\n").expect("source");
        let stamp = std::time::UNIX_EPOCH
            + std::time::Duration::from_millis((fake_now() - age_ms).max(0) as u64);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .and_then(|file| file.set_modified(stamp))
            .expect("mtime");
        path.to_string_lossy().into_owned()
    }

    fn facts(file: &str, keep: bool) -> (Arc<ConfigFacts>, Arc<FakePorts>) {
        let ports = Arc::new(FakePorts {
            sources: Mutex::new(Some(vec![file.to_owned()])),
            computes: AtomicUsize::new(0),
            sources_calls: AtomicUsize::new(0),
            keep,
            now: fake_now(),
        });
        (Arc::new(ConfigFacts::new(ports.clone())), ports)
    }

    #[tokio::test]
    async fn an_unchanged_checkout_keeps_its_fact() {
        let file = source("kept", 10_000);
        let (facts, ports) = facts(&file, true);
        // The first call learns the sources after computing, so its value is not kept yet.
        facts.read(1, "/wt", &[], "root").await.expect("first");
        let second = facts.read(1, "/wt", &[], "root").await.expect("second");
        let third = facts.read(1, "/wt", &[], "root").await.expect("kept");
        assert_eq!(second, third);
        assert_eq!(ports.computes.load(Ordering::SeqCst), 2);
        assert_eq!(ports.sources_calls.load(Ordering::SeqCst), 1);
        std::fs::remove_file(&file).ok();
    }

    #[tokio::test]
    async fn a_changed_source_forgets_the_fact() {
        let file = source("changed", 10_000);
        let (facts, ports) = facts(&file, true);
        facts.read(1, "/wt", &[], "root").await.expect("first");
        std::fs::write(&file, "config\nuser.name = another\n").expect("write");
        let second = facts.read(1, "/wt", &[], "root").await.expect("second");
        assert_eq!(second, Value::from("v2"));
        assert_eq!(ports.computes.load(Ordering::SeqCst), 2);
        std::fs::remove_file(&file).ok();
    }

    #[tokio::test]
    async fn sources_that_have_not_settled_are_not_kept() {
        let file = source("fresh", 0);
        let (facts, ports) = facts(&file, true);
        facts.read(1, "/wt", &[], "root").await.expect("first");
        facts.read(1, "/wt", &[], "root").await.expect("second");
        assert_eq!(ports.computes.load(Ordering::SeqCst), 2);
        std::fs::remove_file(&file).ok();
    }

    #[tokio::test]
    async fn a_owner_that_says_no_is_not_kept() {
        let file = source("unkept", 10_000);
        let (facts, ports) = facts(&file, false);
        facts.read(1, "/wt", &[], "root").await.expect("first");
        facts.read(1, "/wt", &[], "root").await.expect("second");
        assert_eq!(ports.computes.load(Ordering::SeqCst), 2);
        std::fs::remove_file(&file).ok();
    }

    #[tokio::test]
    async fn the_oldest_checkout_is_evicted_beyond_the_capacity() {
        let file = source("evict", 10_000);
        let (facts, ports) = facts(&file, true);
        facts.read(1, "/wt/0", &[], "root").await.expect("first");
        let kept = facts.read(1, "/wt/0", &[], "root").await.expect("kept");
        for index in 1..=CAPACITY {
            facts
                .read(1, &format!("/wt/{index}"), &[], "root")
                .await
                .expect("each");
        }
        // The first checkout fell out of the cache and is computed again.
        let refreshed = facts.read(1, "/wt/0", &[], "root").await.expect("again");
        assert_ne!(refreshed, kept);
        std::fs::remove_file(&file).ok();
        assert!(ports.computes.load(Ordering::SeqCst) >= CAPACITY + 2);
    }
}
