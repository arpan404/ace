//! File work inside one workspace: list, read a window, write, edit, search and delete. Every
//! path goes through [`Workspace::existing`] or [`Workspace::writable`] first.

use std::path::Path;

use serde::Serialize;

use super::{PathError, Workspace};

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
/// Most files a search opens.
const MOST_SEARCHED: usize = 5_000;

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

impl Workspace {
    /// The folder at `relative` (the workspace itself when empty). A workspace never used lists
    /// empty.
    pub fn list(&self, relative: &str) -> Result<Listing, PathError> {
        let folder = self.existing(relative)?;
        let mut entries = Vec::new();
        let mut truncated = false;
        for item in std::fs::read_dir(&folder)? {
            let item = item?;
            if entries.len() == MOST_ENTRIES {
                truncated = true;
                break;
            }
            let meta = std::fs::symlink_metadata(item.path())?;
            let kind = if meta.file_type().is_symlink() {
                EntryKind::Link
            } else if meta.is_dir() {
                EntryKind::Folder
            } else {
                EntryKind::File
            };
            let modified_at = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|d| i64::try_from(d.as_millis()).ok());
            entries.push(Entry {
                name: item.file_name().to_string_lossy().into_owned(),
                path: self.shown(&item.path()),
                kind,
                size: if kind == EntryKind::File {
                    meta.len()
                } else {
                    0
                },
                modified_at,
            });
        }
        entries.sort_by(|a, b| {
            (a.kind != EntryKind::Folder, &a.name).cmp(&(b.kind != EntryKind::Folder, &b.name))
        });
        Ok(Listing {
            path: self.shown(&folder),
            entries,
            truncated,
        })
    }

    /// Lines `offset..offset+limit` (1-based) of a text file, numbered, with how many there are.
    pub fn read_window(
        &self,
        relative: &str,
        offset: usize,
        limit: usize,
    ) -> Result<String, PathError> {
        let path = self.existing(relative)?;
        let text = text_of(&path)?;
        let lines: Vec<&str> = text.lines().collect();
        let total = lines.len();
        let first = offset.max(1);
        if total == 0 {
            return Ok(format!("{relative} is empty."));
        }
        if first > total {
            return Ok(format!(
                "{relative} has {total} lines; line {first} is past its end."
            ));
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
        Ok(out)
    }

    /// Writes `content` to `relative`, creating folders on the way. Answers the bytes written.
    pub fn write(&self, relative: &str, content: &str) -> Result<usize, PathError> {
        if content.len() > LARGEST_WRITE {
            return Err(PathError::Io(format!(
                "that is {} bytes; files are written {LARGEST_WRITE} bytes at most",
                content.len()
            )));
        }
        let path = self.writable(relative)?;
        if path.is_dir() {
            return Err(PathError::Io(format!("{relative} is a folder")));
        }
        std::fs::write(&path, content)?;
        Ok(content.len())
    }

    /// Replaces the one place `old` appears in `relative` with `new`.
    pub fn edit(&self, relative: &str, old: &str, new: &str) -> Result<(), PathError> {
        if old.is_empty() {
            return Err(PathError::Io("give the text to replace".to_owned()));
        }
        let path = self.existing(relative)?;
        let text = text_of(&path)?;
        match text.matches(old).count() {
            0 => Err(PathError::Io(format!(
                "that text is not in {relative}; read it again and copy it exactly"
            ))),
            1 => {
                let changed = text.replacen(old, new, 1);
                if changed.len() > LARGEST_WRITE {
                    return Err(PathError::Io("the file would be too large".to_owned()));
                }
                std::fs::write(&path, changed)?;
                Ok(())
            }
            many => Err(PathError::Io(format!(
                "that text appears {many} times in {relative}; include more around it so it \
                 appears once"
            ))),
        }
    }

    /// Lines containing `needle` under `relative`, as `path:line: text`, without following links.
    pub fn search(
        &self,
        relative: &str,
        needle: &str,
        ignore_case: bool,
    ) -> Result<String, PathError> {
        if needle.is_empty() {
            return Err(PathError::Io("give the text to look for".to_owned()));
        }
        let start = self.existing(relative)?;
        let wanted = if ignore_case {
            needle.to_lowercase()
        } else {
            needle.to_owned()
        };
        let mut found = Vec::new();
        let mut opened = 0;
        let mut stack = vec![start];
        'walk: while let Some(at) = stack.pop() {
            let meta = std::fs::symlink_metadata(&at)?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                let mut children: Vec<_> = std::fs::read_dir(&at)?
                    .filter_map(Result::ok)
                    .map(|e| e.path())
                    .collect();
                children.sort();
                stack.extend(children.into_iter().rev());
                continue;
            }
            if meta.len() > LARGEST_SEARCHED {
                continue;
            }
            opened += 1;
            if opened > MOST_SEARCHED {
                break;
            }
            let Ok(text) = std::fs::read_to_string(&at) else {
                continue;
            };
            for (number, line) in text.lines().enumerate() {
                let haystack = if ignore_case {
                    line.to_lowercase()
                } else {
                    line.to_owned()
                };
                if haystack.contains(&wanted) {
                    let shown: String = line.chars().take(400).collect();
                    found.push(format!("{}:{}: {shown}", self.shown(&at), number + 1));
                    if found.len() == MOST_MATCHES {
                        found.push(format!("[Stopped at {MOST_MATCHES} matches.]"));
                        break 'walk;
                    }
                }
            }
        }
        if found.is_empty() {
            return Ok(format!("No line contains {needle:?}."));
        }
        Ok(found.join("\n"))
    }

    /// The file at `relative` for the app: its text when it can be read as such.
    pub fn open(&self, relative: &str) -> Result<FileView, PathError> {
        let path = self.existing(relative)?;
        let meta = std::fs::metadata(&path)?;
        if meta.is_dir() {
            return Err(PathError::Io(format!("{relative} is a folder")));
        }
        let (text, unreadable) = if meta.len() > LARGEST_TEXT {
            (None, Some("too_large"))
        } else {
            match String::from_utf8(std::fs::read(&path)?) {
                Ok(text) => (Some(text), None),
                Err(_) => (None, Some("binary")),
            }
        };
        Ok(FileView {
            path: self.shown(&path),
            size: meta.len(),
            text,
            unreadable,
        })
    }

    /// The file's bytes, for a download.
    pub fn bytes(&self, relative: &str) -> Result<Vec<u8>, PathError> {
        let path = self.existing(relative)?;
        if path.is_dir() {
            return Err(PathError::Io(format!("{relative} is a folder")));
        }
        Ok(std::fs::read(path)?)
    }

    /// Deletes a file, link or folder (with what is in it). The workspace itself stays.
    pub fn delete(&self, relative: &str) -> Result<(), PathError> {
        let root = self.root()?;
        let cleaned = super::clean(relative)?;
        if cleaned.as_os_str().is_empty() {
            return Err(PathError::Io(
                "the workspace itself cannot be deleted".to_owned(),
            ));
        }
        // The entry itself, not where a link leads: its folder must be inside.
        let parent = root.join(cleaned.parent().unwrap_or(Path::new("")));
        let folder =
            std::fs::canonicalize(&parent).map_err(|_| PathError::Missing(relative.to_owned()))?;
        super::inside(&root, &folder, relative)?;
        let Some(name) = cleaned.file_name() else {
            return Err(PathError::Missing(relative.to_owned()));
        };
        let target = folder.join(name);
        let meta = std::fs::symlink_metadata(&target)
            .map_err(|_| PathError::Missing(relative.to_owned()))?;
        if meta.is_dir() {
            std::fs::remove_dir_all(&target)?;
        } else {
            std::fs::remove_file(&target)?;
        }
        Ok(())
    }
}

fn text_of(path: &Path) -> Result<String, PathError> {
    let meta = std::fs::metadata(path)?;
    if meta.is_dir() {
        return Err(PathError::Io(
            "that is a folder; list it with workspace_list".to_owned(),
        ));
    }
    if meta.len() > LARGEST_TEXT {
        return Err(PathError::Io(format!(
            "the file is {} bytes; text files are read up to {LARGEST_TEXT} bytes",
            meta.len()
        )));
    }
    String::from_utf8(std::fs::read(path)?).map_err(|_| {
        PathError::Io(format!(
            "the file is not text ({} bytes of binary)",
            meta.len()
        ))
    })
}
