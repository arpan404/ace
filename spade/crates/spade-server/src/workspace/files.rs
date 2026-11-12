//! File work inside one workspace: list, read, write, edit, search and delete, all through the
//! workspace's directory handle (see the module above).

use std::io::{Read, Write};
use std::path::Path;
use std::time::SystemTime;

use cap_fs_ext::{FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use serde::Serialize;

use super::{PathError, Workspace, clean, shown, taint};

/// Most entries one listing returns.
pub const MOST_ENTRIES: usize = 500;
/// Largest file written or edited at once.
pub const LARGEST_WRITE: usize = 2 * 1024 * 1024;
/// Largest file opened as text, by the tools and by the app.
pub const LARGEST_TEXT: u64 = 4 * 1024 * 1024;
/// Lines one read returns when the model names no limit, and at most.
pub const READ_LINES: usize = 400;
pub const MOST_READ_LINES: usize = 2_000;
/// Longest line a read shows; the rest is cut.
const LINE_CHARS: usize = 2_000;
/// Most matches a search returns, and the largest file it looks in.
const MOST_MATCHES: usize = 200;
const LARGEST_SEARCHED: u64 = 2 * 1024 * 1024;
/// Most files a search, or a look for changed files, opens.
const MOST_WALKED: usize = 5_000;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Folder,
    File,
    Link,
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    /// Relative to the workspace, with `/`.
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Milliseconds since the epoch, when the system says.
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Listing {
    pub path: String,
    /// Folders first, then by name.
    pub entries: Vec<Entry>,
    /// More entries than [`MOST_ENTRIES`] were there.
    pub truncated: bool,
}

/// A file as the app opens it: text when it is UTF-8 and small enough.
#[derive(Debug, Clone, Serialize)]
pub struct FileView {
    pub path: String,
    pub size: u64,
    pub text: Option<String>,
    /// Why `text` is absent: `binary` or `too_large`.
    pub unreadable: Option<&'static str>,
}

/// What a search found: its lines for the model, and each file it quoted, with its hash.
pub struct Found {
    pub text: String,
    pub files: Vec<(String, String)>,
}

/// The folder at `cleaned` (the workspace itself when empty).
fn folder(dir: &Dir, cleaned: &Path, relative: &str) -> Result<Dir, PathError> {
    if cleaned.as_os_str().is_empty() {
        return Ok(dir.try_clone()?);
    }
    dir.open_dir(cleaned)
        .map_err(|error| PathError::at(relative, error))
}

fn millis(time: std::io::Result<cap_std::time::SystemTime>) -> Option<i64> {
    time.ok()
        .map(cap_std::time::SystemTime::into_std)
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
}

impl Workspace {
    /// The folder at `relative` (the workspace itself when empty).
    pub fn list(&self, relative: &str) -> Result<Listing, PathError> {
        let cleaned = clean(relative)?;
        let at = folder(&self.dir()?, &cleaned, relative)?;
        let mut entries = Vec::new();
        let mut truncated = false;
        for item in at.entries()? {
            let item = item?;
            if entries.len() == MOST_ENTRIES {
                truncated = true;
                break;
            }
            let name = item.file_name();
            let meta = at.symlink_metadata(&name)?;
            let kind = if meta.file_type().is_symlink() {
                EntryKind::Link
            } else if meta.is_dir() {
                EntryKind::Folder
            } else {
                EntryKind::File
            };
            entries.push(Entry {
                name: name.to_string_lossy().into_owned(),
                path: shown(&cleaned.join(&name)),
                kind,
                size: if kind == EntryKind::File {
                    meta.len()
                } else {
                    0
                },
                modified_at: millis(meta.modified()),
            });
        }
        entries.sort_by(|a, b| {
            (a.kind != EntryKind::Folder, &a.name).cmp(&(b.kind != EntryKind::Folder, &b.name))
        });
        Ok(Listing {
            path: shown(&cleaned),
            entries,
            truncated,
        })
    }

    /// A file's bytes, at most `largest`.
    fn read_file(&self, relative: &str, largest: u64) -> Result<Vec<u8>, PathError> {
        let cleaned = clean(relative)?;
        if cleaned.as_os_str().is_empty() {
            return Err(PathError::Io("that is the workspace itself".to_owned()));
        }
        let mut file = self
            .dir()?
            .open(&cleaned)
            .map_err(|error| PathError::at(relative, error))?;
        let meta = file.metadata()?;
        if meta.is_dir() {
            return Err(PathError::Io(format!(
                "{relative} is a folder; list it with workspace_list"
            )));
        }
        if meta.len() > largest {
            return Err(PathError::Io(format!(
                "{relative} is {} bytes; files are read up to {largest} bytes",
                meta.len()
            )));
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(largest + 1)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    /// A text file's content.
    pub fn text(&self, relative: &str) -> Result<String, PathError> {
        let bytes = self.read_file(relative, LARGEST_TEXT)?;
        let size = bytes.len();
        String::from_utf8(bytes)
            .map_err(|_| PathError::Io(format!("{relative} is not text ({size} bytes of binary)")))
    }

    /// Writes `content` to `relative`, creating folders on the way: into a new file beside it,
    /// renamed over the old one. A file with other hard links is refused. Answers the bytes
    /// written.
    pub fn write(&self, relative: &str, content: &str) -> Result<usize, PathError> {
        if content.len() > LARGEST_WRITE {
            return Err(PathError::Io(format!(
                "that is {} bytes; files are written {LARGEST_WRITE} bytes at most",
                content.len()
            )));
        }
        let cleaned = clean(relative)?;
        let Some(name) = cleaned.file_name().map(ToOwned::to_owned) else {
            return Err(PathError::Io("give a file name".to_owned()));
        };
        let dir = self.dir()?;
        let parent = cleaned.parent().unwrap_or(Path::new(""));
        if !parent.as_os_str().is_empty() {
            dir.create_dir_all(parent)
                .map_err(|error| PathError::at(relative, error))?;
        }
        let at = folder(&dir, parent, relative)?;
        match at.symlink_metadata(&name) {
            Ok(meta) if meta.is_dir() => {
                return Err(PathError::Io(format!("{relative} is a folder")));
            }
            Ok(meta) if meta.is_file() => {
                let mut options = OpenOptions::new();
                options.read(true).follow(FollowSymlinks::No);
                let file = at
                    .open_with(&name, &options)
                    .map_err(|error| PathError::at(relative, error))?;
                if file.metadata()?.nlink() > 1 {
                    return Err(PathError::Io(format!(
                        "{relative} has other hard links, so writing it could change another \
                         file; write a new file instead"
                    )));
                }
            }
            // A link is replaced by the new file, never written through.
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(PathError::at(relative, error)),
        }
        let temporary = format!(
            ".{}.spade-{}",
            name.to_string_lossy(),
            uuid::Uuid::new_v4().simple()
        );
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let written = at.open_with(&temporary, &options).and_then(|mut file| {
            file.write_all(content.as_bytes())?;
            file.sync_all()
        });
        let renamed = written.and_then(|()| at.rename(&temporary, &at, &name));
        if let Err(error) = renamed {
            let _ = at.remove_file(&temporary);
            return Err(PathError::at(relative, error));
        }
        Ok(content.len())
    }

    /// Replaces the one place `old` appears in `relative` with `new`. Answers the file's text
    /// before and after.
    pub fn edit(
        &self,
        relative: &str,
        old: &str,
        new: &str,
    ) -> Result<(String, String), PathError> {
        if old.is_empty() {
            return Err(PathError::Io("give the text to replace".to_owned()));
        }
        let text = self.text(relative)?;
        match text.matches(old).count() {
            0 => Err(PathError::Io(format!(
                "that text is not in {relative}; read it again and copy it exactly"
            ))),
            1 => {
                let changed = text.replacen(old, new, 1);
                self.write(relative, &changed)?;
                Ok((text, changed))
            }
            many => Err(PathError::Io(format!(
                "that text appears {many} times in {relative}; include more around it so it \
                 appears once"
            ))),
        }
    }

    /// Every regular file under the workspace (links not followed), with its handle's folder.
    fn walk(
        &self,
        start: &str,
        mut visit: impl FnMut(&Dir, &str, &str) -> bool,
    ) -> Result<(), PathError> {
        let cleaned = clean(start)?;
        let dir = self.dir()?;
        let mut stack = vec![shown(&cleaned)];
        let mut opened = 0;
        while let Some(path) = stack.pop() {
            let at = folder(&dir, Path::new(&path), &path)?;
            let mut names: Vec<String> = at
                .entries()?
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            let mut folders = Vec::new();
            for name in names {
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
                    folders.push(full);
                    continue;
                }
                opened += 1;
                if opened > MOST_WALKED || !visit(&at, &name, &full) {
                    return Ok(());
                }
            }
            stack.extend(folders.into_iter().rev());
        }
        Ok(())
    }

    /// Lines containing `needle` under `relative`, as `path:line: text`, links not followed.
    pub fn search(
        &self,
        relative: &str,
        needle: &str,
        ignore_case: bool,
    ) -> Result<Found, PathError> {
        if needle.is_empty() {
            return Err(PathError::Io("give the text to look for".to_owned()));
        }
        let wanted = if ignore_case {
            needle.to_lowercase()
        } else {
            needle.to_owned()
        };
        let mut lines = Vec::new();
        let mut files = Vec::new();
        self.walk(relative, |at, name, full| {
            let Ok(mut file) = at.open(name) else {
                return true;
            };
            if file.metadata().map(|m| m.len()).unwrap_or(u64::MAX) > LARGEST_SEARCHED {
                return true;
            }
            let mut bytes = Vec::new();
            if file.read_to_end(&mut bytes).is_err() {
                return true;
            }
            let Ok(text) = std::str::from_utf8(&bytes) else {
                return true;
            };
            let mut quoted = false;
            for (number, line) in text.lines().enumerate() {
                let haystack = if ignore_case {
                    line.to_lowercase()
                } else {
                    line.to_owned()
                };
                if haystack.contains(&wanted) {
                    quoted = true;
                    let shown: String = line.chars().take(400).collect();
                    lines.push(format!("{full}:{}: {shown}", number + 1));
                    if lines.len() == MOST_MATCHES {
                        lines.push(format!("[Stopped at {MOST_MATCHES} matches.]"));
                        files.push((full.to_owned(), taint::hash(&bytes)));
                        return false;
                    }
                }
            }
            if quoted {
                files.push((full.to_owned(), taint::hash(&bytes)));
            }
            true
        })?;
        let text = if lines.is_empty() {
            format!("No line contains {needle:?}.")
        } else {
            lines.join("\n")
        };
        Ok(Found { text, files })
    }

    /// Every file changed (written, created, moved or linked) at or after `since`, with its
    /// content's hash.
    pub fn changed_since(&self, since: SystemTime) -> Vec<(String, String)> {
        let mut changed = Vec::new();
        let _ = self.walk("", |at, name, full| {
            let Ok(meta) = at.symlink_metadata(name) else {
                return true;
            };
            let touched = |time: std::io::Result<cap_std::time::SystemTime>| {
                time.ok().is_some_and(|t| t.into_std() >= since)
            };
            #[cfg(unix)]
            let status_changed = {
                use cap_std::fs::MetadataExt as _;
                let seconds = u64::try_from(meta.ctime()).unwrap_or(0);
                let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds);
                // ctime has whole seconds here; a change in the same second counts.
                at + std::time::Duration::from_secs(1) > since
            };
            #[cfg(not(unix))]
            let status_changed = false;
            if touched(meta.modified()) || touched(meta.created()) || status_changed {
                let mut bytes = Vec::new();
                if let Ok(mut file) = at.open(name) {
                    let _ = Read::by_ref(&mut file)
                        .take(LARGEST_TEXT)
                        .read_to_end(&mut bytes);
                }
                changed.push((full.to_owned(), taint::hash(&bytes)));
            }
            true
        });
        changed
    }

    /// The file at `relative` for the app: its text when it can be read as such.
    pub fn open(&self, relative: &str) -> Result<FileView, PathError> {
        let cleaned = clean(relative)?;
        let meta = self
            .dir()?
            .metadata(&cleaned)
            .map_err(|error| PathError::at(relative, error))?;
        if meta.is_dir() {
            return Err(PathError::Io(format!("{relative} is a folder")));
        }
        let (text, unreadable) = if meta.len() > LARGEST_TEXT {
            (None, Some("too_large"))
        } else {
            match String::from_utf8(self.read_file(relative, LARGEST_TEXT)?) {
                Ok(text) => (Some(text), None),
                Err(_) => (None, Some("binary")),
            }
        };
        Ok(FileView {
            path: shown(&cleaned),
            size: meta.len(),
            text,
            unreadable,
        })
    }

    /// The file's bytes, for a download.
    pub fn bytes(&self, relative: &str) -> Result<Vec<u8>, PathError> {
        self.read_file(relative, u64::MAX / 2)
    }

    /// Deletes a file, link or folder (with what is in it). The workspace itself stays.
    pub fn delete(&self, relative: &str) -> Result<(), PathError> {
        let cleaned = clean(relative)?;
        let Some(name) = cleaned.file_name() else {
            return Err(PathError::Io(
                "the workspace itself cannot be deleted".to_owned(),
            ));
        };
        let dir = self.dir()?;
        let at = folder(&dir, cleaned.parent().unwrap_or(Path::new("")), relative)?;
        let meta = at
            .symlink_metadata(name)
            .map_err(|error| PathError::at(relative, error))?;
        if meta.is_dir() {
            at.remove_dir_all(name)?;
        } else {
            at.remove_file(name)?;
        }
        Ok(())
    }
}

/// Lines `offset..offset+limit` (1-based) of `text`, numbered, with how many there are.
pub fn window(relative: &str, text: &str, offset: usize, limit: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let first = offset.max(1);
    if total == 0 {
        return format!("{relative} is empty.");
    }
    if first > total {
        return format!("{relative} has {total} lines; line {first} is past its end.");
    }
    let last = (first - 1 + limit.clamp(1, MOST_READ_LINES)).min(total);
    let mut out = format!("{relative}, lines {first}-{last} of {total}:\n");
    for (number, line) in lines[first - 1..last].iter().enumerate() {
        let shown: String = line.chars().take(LINE_CHARS).collect();
        let cut = if shown.len() < line.len() {
            " […]"
        } else {
            ""
        };
        out.push_str(&format!("{:>6}  {shown}{cut}\n", first + number));
    }
    if last < total {
        out.push_str(&format!(
            "[{} more lines; read on from line {}.]",
            total - last,
            last + 1
        ));
    }
    out
}
