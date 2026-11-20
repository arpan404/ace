// SPDX-License-Identifier: Apache-2.0

//! The list of every file the search bench's generator writes, so regenerating removes exactly
//! those and never a file a person added, even inside a folder the generator also uses.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// One relative path per line, written before the first generated file.
pub const MANIFEST: &str = ".ace-search-bench-manifest";

/// Records `paths`, relative to `dir`, before any of them is written: a generation that stops
/// half way still leaves a list that covers everything it wrote.
pub fn record(dir: &Path, paths: &[String]) -> io::Result<()> {
    let mut text = String::with_capacity(paths.len() * 48);
    for path in paths {
        text.push_str(path);
        text.push('\n');
    }
    fs::write(dir.join(MANIFEST), text)
}

/// Removes the files the last generation recorded, then the folders that leaves empty, deepest
/// first. Only regular files are removed; a link or folder now sitting at a recorded path is left
/// alone, and so is a folder that still holds anything. A tree with no list removes nothing.
pub fn remove_recorded(dir: &Path) -> io::Result<()> {
    let text = match fs::read_to_string(dir.join(MANIFEST)) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut folders = BTreeSet::new();
    for line in text.lines() {
        let Some(relative) = relative(line) else {
            return Err(io::Error::other(format!(
                "{} lists {line:?}, which is not a path inside the tree",
                dir.join(MANIFEST).display()
            )));
        };
        let path = dir.join(&relative);
        if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_file()) {
            fs::remove_file(&path)?;
        }
        let mut parent = relative.parent();
        while let Some(folder) = parent.filter(|folder| !folder.as_os_str().is_empty()) {
            folders.insert(folder.to_path_buf());
            parent = folder.parent();
        }
    }
    let mut folders: Vec<PathBuf> = folders.into_iter().collect();
    folders.sort_by_key(|folder| std::cmp::Reverse(folder.components().count()));
    for folder in folders {
        let path = dir.join(folder);
        if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_dir()) {
            // A folder that still holds something a person put there stays.
            let _ = fs::remove_dir(&path);
        }
    }
    fs::remove_file(dir.join(MANIFEST))
}

/// `line` as a path inside the tree: relative, every part a plain name.
fn relative(line: &str) -> Option<PathBuf> {
    let path = Path::new(line);
    let plain = !line.is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    plain.then(|| path.to_path_buf())
}
