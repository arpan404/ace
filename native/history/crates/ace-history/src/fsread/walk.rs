// SPDX-License-Identifier: Apache-2.0

//! `walkFiles`: regular files under a root, depth and entry bounded, symlinks never followed.

use std::path::Path;

use crate::cancel::Cancel;
use crate::error::{Error, Result, io_at};

/// Entries seen across one inventory walk.
#[derive(Debug, Default)]
pub struct Budget {
    pub entries: usize,
}

/// Call `found` with each regular file under `root`, in directory order. A missing root is empty.
pub fn walk_files(
    root: &Path,
    cancel: &Cancel,
    budget: &mut Budget,
    found: &mut dyn FnMut(&Path) -> Result<()>,
) -> Result<()> {
    walk(root, cancel, budget, 0, found)
}

fn walk(
    root: &Path,
    cancel: &Cancel,
    budget: &mut Budget,
    depth: usize,
    found: &mut dyn FnMut(&Path) -> Result<()>,
) -> Result<()> {
    cancel.check()?;
    if depth > 16 {
        return Err(Error::message("Session directory depth limit exceeded"));
    }
    let info = match std::fs::symlink_metadata(root) {
        Ok(info) => info,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_at(error, root)),
    };
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err(Error::message("Session directory is not a real directory"));
    }
    for entry in std::fs::read_dir(root).map_err(|e| io_at(e, root))? {
        cancel.check()?;
        let entry = entry.map_err(|e| io_at(e, root))?;
        budget.entries += 1;
        if budget.entries > 100_000 {
            return Err(Error::message("Session inventory limit exceeded"));
        }
        let path = entry.path();
        let kind = entry.file_type().map_err(|e| io_at(e, &path))?;
        if kind.is_dir() {
            walk(&path, cancel, budget, depth + 1, found)?;
        } else if kind.is_file() {
            found(&path)?;
        }
        // Symlinks and special files are never followed.
    }
    Ok(())
}
