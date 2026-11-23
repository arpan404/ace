//! Walking a workspace's files for a search, a find or the look at what a run changed: one
//! folder handle at a time, each opened by name without following a link (the start's folders
//! too), within a budget of entries and time checked at every entry, never only between files.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};

use super::matching::{Glob, Needle};
use super::{PathError, Workspace, clean, trust};

/// Most matches a search returns.
const MOST_MATCHES: usize = 200;
/// The largest file a search reads; a file past it (or grown past it since) is left out.
const LARGEST_SEARCHED: u64 = 2 * 1024 * 1024;
/// How long one search or find looks before it answers with what it found.
pub const LOOK_TIME: Duration = Duration::from_secs(5);
/// Most entries (files and folders) one walk visits.
pub const MOST_VISITED: usize = 20_000;
/// How many lines a search reads between looks at the clock.
const LINES_PER_CHECK: usize = 4_096;

/// What a search found: its lines for the model, and each file it quoted, with its hash.
pub struct Found {
    pub text: String,
    pub files: Vec<(String, String)>,
}

/// Files a find named, each with its size, and the note saying why it stopped early, if it did.
pub type Listed = (Vec<(String, u64)>, Option<String>);

/// Why a walk stopped before it had seen everything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cut {
    Time,
    Entries,
}

impl Cut {
    /// The note a result ends with.
    pub fn note(self) -> String {
        match self {
            Self::Time => format!(
                "[Stopped after {} seconds; give a path or glob to look in fewer files.]",
                LOOK_TIME.as_secs()
            ),
            Self::Entries => format!(
                "[Stopped after {MOST_VISITED} entries; give a path or glob to look in fewer \
                 files.]"
            ),
        }
    }
}

/// What a walk may spend.
struct Budget {
    until: Option<Instant>,
    visited: usize,
}

impl Budget {
    fn timed() -> Self {
        Self {
            until: Some(Instant::now() + LOOK_TIME),
            visited: 0,
        }
    }

    fn untimed() -> Self {
        Self {
            until: None,
            visited: 0,
        }
    }

    fn late(&self) -> bool {
        self.until.is_some_and(|until| Instant::now() > until)
    }

    /// Counts one entry; why to stop, if it is time.
    fn spend(&mut self) -> Option<Cut> {
        self.visited += 1;
        if self.visited > MOST_VISITED {
            return Some(Cut::Entries);
        }
        self.late().then_some(Cut::Time)
    }
}

/// What a visitor says after a file.
enum Next {
    Go,
    Stop,
    Late,
}

/// A file, as a walk shows it to its visitor.
struct Seen<'a> {
    at: &'a Dir,
    name: &'a str,
    path: &'a str,
    meta: &'a cap_std::fs::Metadata,
}

/// The file `name` in `at`, opened without following a link and without waiting on a pipe, and
/// answered only when the opened handle is a regular file (checked on the handle, never by name
/// first).
pub(super) fn open_file_no_follow(
    at: &Dir,
    name: &std::ffi::OsStr,
) -> std::io::Result<cap_std::fs::File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(super::files::NONBLOCK);
    }
    let file = at.open_with(name, &options)?;
    if file.metadata()?.is_file() {
        Ok(file)
    } else {
        Err(std::io::Error::other("not a regular file"))
    }
}

/// The folder at `cleaned` under `dir`, each part opened without following a link.
fn open_folder(dir: &Dir, cleaned: &Path, relative: &str) -> Result<Dir, PathError> {
    let mut at = dir.try_clone()?;
    for part in cleaned.components() {
        at = at
            .open_dir_nofollow(part.as_os_str())
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => PathError::Missing(relative.to_owned()),
                _ => PathError::Io(format!(
                    "{relative} is not a folder in your workspace (a link is not followed)"
                )),
            })?;
    }
    Ok(at)
}

impl Workspace {
    /// Every regular file under `start` (links never followed, pipes and devices never opened),
    /// by path, until the visitor stops or `budget` runs out. `skip` names a folder (from the
    /// top) not walked into. Answers why it stopped early, if it did.
    fn walk(
        &self,
        start: &str,
        budget: &mut Budget,
        skip: Option<&str>,
        mut visit: impl FnMut(Seen<'_>) -> Next,
    ) -> Result<Option<Cut>, PathError> {
        let cleaned = clean(start)?;
        let first = open_folder(&self.dir()?, &cleaned, start)?;
        let mut stack = vec![(first, super::shown(&cleaned))];
        while let Some((at, path)) = stack.pop() {
            let mut names: Vec<String> = Vec::new();
            for entry in at.entries()? {
                if let Some(cut) = budget.spend() {
                    return Ok(Some(cut));
                }
                if let Ok(entry) = entry {
                    names.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
            names.sort();
            let mut folders = Vec::new();
            for name in names {
                if budget.late() {
                    return Ok(Some(Cut::Time));
                }
                let Ok(meta) = at.symlink_metadata(&name) else {
                    continue;
                };
                let full = if path.is_empty() {
                    name.clone()
                } else {
                    format!("{path}/{name}")
                };
                if meta.file_type().is_symlink() {
                    continue;
                }
                if meta.is_dir() {
                    if Some(full.as_str()) != skip
                        && let Ok(inner) = at.open_dir_nofollow(&name)
                    {
                        folders.push((inner, full));
                    }
                    continue;
                }
                if !meta.is_file() {
                    continue;
                }
                let seen = Seen {
                    at: &at,
                    name: &name,
                    path: &full,
                    meta: &meta,
                };
                match visit(seen) {
                    Next::Go => {}
                    Next::Stop => return Ok(None),
                    Next::Late => return Ok(Some(Cut::Time)),
                }
            }
            stack.extend(folders.into_iter().rev());
        }
        Ok(None)
    }

    /// Lines holding `needle` under `relative`, in files that fit `only` (all when `None`), as
    /// `path:line: text`, links not followed. Stops at [`MOST_MATCHES`] lines or when its budget
    /// runs out.
    pub fn search(
        &self,
        relative: &str,
        needle: &Needle,
        only: Option<&Glob>,
    ) -> Result<Found, PathError> {
        let mut budget = Budget::timed();
        let mut lines = Vec::new();
        let mut files = Vec::new();
        let deadline = budget.until;
        let late = || deadline.is_some_and(|until| Instant::now() > until);
        let cut = self.walk(relative, &mut budget, None, |seen| {
            if only.is_some_and(|glob| !glob.fits(seen.path)) || seen.meta.len() > LARGEST_SEARCHED
            {
                return Next::Go;
            }
            // Opened by name without following a link, and checked on the handle: a file swapped
            // for a link after the folder was listed is never read through.
            let Ok(file) = open_file_no_follow(seen.at, std::ffi::OsStr::new(seen.name)) else {
                return Next::Go;
            };
            // Read no more than the cap, whatever the file has grown to since.
            let mut bytes = Vec::new();
            if file
                .take(LARGEST_SEARCHED + 1)
                .read_to_end(&mut bytes)
                .is_err()
                || bytes.len() as u64 > LARGEST_SEARCHED
            {
                return Next::Go;
            }
            let Ok(text) = std::str::from_utf8(&bytes) else {
                return Next::Go;
            };
            let mut quoted = false;
            for (number, line) in text.lines().enumerate() {
                if number % LINES_PER_CHECK == LINES_PER_CHECK - 1 && late() {
                    if quoted {
                        files.push((seen.path.to_owned(), trust::hash(&bytes)));
                    }
                    return Next::Late;
                }
                if needle.finds(line) {
                    quoted = true;
                    let shown: String = line.chars().take(400).collect();
                    lines.push(format!("{}:{}: {shown}", seen.path, number + 1));
                    if lines.len() == MOST_MATCHES {
                        lines.push(format!("[Stopped at {MOST_MATCHES} matches.]"));
                        files.push((seen.path.to_owned(), trust::hash(&bytes)));
                        return Next::Stop;
                    }
                }
            }
            if quoted {
                files.push((seen.path.to_owned(), trust::hash(&bytes)));
            }
            Next::Go
        })?;
        if let Some(cut) = cut {
            lines.push(cut.note());
        }
        let text = if lines.is_empty() {
            "No line matches.".to_owned()
        } else {
            lines.join("\n")
        };
        Ok(Found { text, files })
    }

    /// Files under `relative` whose path fits `glob`, with their sizes, links not followed; at
    /// most [`super::files::MOST_ENTRIES`], by path. Answers the files and, when it stopped
    /// early, the note saying why.
    pub fn find(&self, relative: &str, glob: &Glob) -> Result<Listed, PathError> {
        let most = super::files::MOST_ENTRIES;
        let mut found = Vec::new();
        let mut more = false;
        let cut = self.walk(relative, &mut Budget::timed(), None, |seen| {
            if !glob.fits(seen.path) {
                return Next::Go;
            }
            if found.len() == most {
                more = true;
                return Next::Stop;
            }
            found.push((seen.path.to_owned(), seen.meta.len()));
            Next::Go
        })?;
        found.sort();
        let note = match cut {
            Some(cut) => Some(cut.note()),
            None if more => Some(format!(
                "[Only the first {most} shown; narrow the pattern.]"
            )),
            None => None,
        };
        Ok((found, note))
    }

    /// Every regular file in the workspace with what tells a change apart (Spade's own `.spade`
    /// folder left out, links never followed), and whether there were more than a walk visits.
    pub fn stamps(&self) -> Result<(Stamps, bool), PathError> {
        let mut stamps = Stamps::new();
        let cut = self.walk("", &mut Budget::untimed(), Some(".spade"), |seen| {
            stamps.insert(seen.path.to_owned(), Stamp::of(seen.meta));
            Next::Go
        })?;
        Ok((stamps, cut.is_some()))
    }

    /// The Python modules under `folder` (`.py` regular files, links never followed, Spade's
    /// `.spade` folder left out), by path from the workspace's top, at most `most`, within a timed
    /// budget.
    pub fn python_files(&self, folder: &str, most: usize) -> Result<Vec<String>, PathError> {
        let mut found = Vec::new();
        let skip = if folder.is_empty() {
            Some(".spade")
        } else {
            None
        };
        self.walk(folder, &mut Budget::timed(), skip, |seen| {
            if seen.path.ends_with(".py") {
                found.push(seen.path.to_owned());
            }
            if found.len() >= most {
                Next::Stop
            } else {
                Next::Go
            }
        })?;
        Ok(found)
    }

    /// A regular file's bytes, at most `largest`, reached through real folders only: every folder
    /// on the way and the file itself are opened without following a link, and the file is
    /// checked to be a regular file after it is opened.
    pub fn bytes_no_follow(&self, relative: &str, largest: u64) -> Result<Vec<u8>, PathError> {
        let cleaned = clean(relative)?;
        let Some(name) = cleaned.file_name() else {
            return Err(PathError::Io("that is the workspace itself".to_owned()));
        };
        let parent = cleaned.parent().unwrap_or(Path::new(""));
        let at = open_folder(&self.dir()?, parent, relative)?;
        let file = open_file_no_follow(&at, name).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => PathError::Missing(relative.to_owned()),
            _ => PathError::Io(format!(
                "{relative} is not a regular file in your workspace (a link is not followed)"
            )),
        })?;
        let mut bytes = Vec::new();
        file.take(largest + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > largest {
            return Err(PathError::Io(format!(
                "{relative} is larger than {largest} bytes"
            )));
        }
        Ok(bytes)
    }
}

/// What tells one file's versions apart: its size, its modification time to the nanosecond and
/// its inode (a file written anew and renamed in place has another). A rewrite to the same size,
/// in place, within the file system's timestamp precision is not told apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub size: u64,
    pub modified: Option<u128>,
    pub inode: u64,
}

impl Stamp {
    fn of(meta: &cap_std::fs::Metadata) -> Self {
        Self {
            size: meta.len(),
            modified: meta
                .modified()
                .ok()
                .map(cap_std::time::SystemTime::into_std)
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos()),
            inode: meta.ino(),
        }
    }
}

/// Every regular file by path.
pub type Stamps = BTreeMap<String, Stamp>;

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn workspace(root: &Path) -> Workspace {
        super::super::Workspaces::new(root)
            .of("b1")
            .unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn a_walk_never_enters_a_linked_folder_even_as_its_start() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let ws = workspace(root.path());
        let dir = ws.path().unwrap_or_else(|e| panic!("{e}"));
        std::fs::create_dir_all(dir.join("real")).unwrap_or_default();
        std::fs::write(dir.join("real/a.txt"), "needle").unwrap_or_default();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("alias")).unwrap_or_default();
        let needle = Needle::new("needle", false, false).unwrap_or_else(|e| panic!("{e}"));
        let found = ws
            .search("", &needle, None)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(found.text, "real/a.txt:1: needle");
        assert!(ws.search("alias", &needle, None).is_err());
        let glob = Glob::new("*.txt").unwrap_or_else(|e| panic!("{e}"));
        assert!(ws.find("alias", &glob).is_err());
        assert!(ws.bytes_no_follow("alias/a.txt", 100).is_err());
        assert_eq!(
            ws.bytes_no_follow("real/a.txt", 100).ok().as_deref(),
            Some(&b"needle"[..])
        );
    }

    #[test]
    fn a_file_is_opened_by_name_without_following_a_link_and_checked_on_its_handle() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let dir = root.path();
        std::fs::write(dir.join("real.txt"), "real").unwrap_or_default();
        std::os::unix::fs::symlink(dir.join("real.txt"), dir.join("alias.txt")).unwrap_or_default();
        std::fs::create_dir_all(dir.join("folder")).unwrap_or_default();
        let at = Dir::open_ambient_dir(dir, cap_std::ambient_authority())
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(open_file_no_follow(&at, std::ffi::OsStr::new("real.txt")).is_ok());
        assert!(open_file_no_follow(&at, std::ffi::OsStr::new("alias.txt")).is_err());
        assert!(open_file_no_follow(&at, std::ffi::OsStr::new("folder")).is_err());
    }

    #[test]
    fn a_tree_of_folders_alone_stops_at_the_entry_budget() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let ws = workspace(root.path());
        let dir = ws.path().unwrap_or_else(|e| panic!("{e}"));
        // Folders only: a budget counted per file would never be spent.
        for a in 0..150 {
            for b in 0..150 {
                std::fs::create_dir_all(dir.join(format!("d{a}/e{b}"))).unwrap_or_default();
            }
        }
        let glob = Glob::new("*.csv").unwrap_or_else(|e| panic!("{e}"));
        let (found, note) = ws.find("", &glob).unwrap_or_else(|e| panic!("{e}"));
        assert!(found.is_empty());
        assert_eq!(note, Some(Cut::Entries.note()));
    }

    #[test]
    fn stamps_see_only_regular_files_and_tell_a_same_size_rewrite_apart() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let ws = workspace(root.path());
        let dir = ws.path().unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(dir.join("a.txt"), "one").unwrap_or_default();
        std::os::unix::fs::symlink(dir.join("a.txt"), dir.join("alias.txt")).unwrap_or_default();
        std::fs::create_dir_all(dir.join(".spade/tmp")).unwrap_or_default();
        std::fs::write(dir.join(".spade/tmp/x"), "x").unwrap_or_default();
        let (before, cut) = ws.stamps().unwrap_or_else(|e| panic!("{e}"));
        assert!(!cut);
        assert_eq!(before.keys().collect::<Vec<_>>(), vec!["a.txt"]);
        // The same size, written anew and renamed over it, as most programs save.
        std::fs::write(dir.join("a.new"), "two").unwrap_or_default();
        std::fs::rename(dir.join("a.new"), dir.join("a.txt")).unwrap_or_default();
        let (after, _) = ws.stamps().unwrap_or_else(|e| panic!("{e}"));
        assert_ne!(before.get("a.txt"), after.get("a.txt"));
    }
}
