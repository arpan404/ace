// SPDX-License-Identifier: Apache-2.0
//! What is at the home path, read without drawing conclusions (`readFacts`).

use std::fs;
use std::io;
use std::path::Path;

use super::{Facts, HOME_FORMAT_FILE, HomeError, io_error, marker_version};

pub(super) fn read_facts(root: &Path) -> Result<Facts, HomeError> {
    if let Ok(metadata) = fs::symlink_metadata(root)
        && !metadata.is_dir()
        && !metadata.file_type().is_symlink()
    {
        return Err(io_error(
            format!("Refusing ace data home {}", root.display()),
            io::Error::other("it is not a directory"),
        ));
    }
    let names = match fs::read_dir(root) {
        Ok(entries) => {
            let mut names = Vec::new();
            for entry in entries {
                let entry = entry
                    .map_err(|error| io_error(format!("Cannot read {}", root.display()), error))?;
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
            names
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // A link to nothing is still something at the path: set it aside.
            return Ok(if fs::symlink_metadata(root).is_ok() {
                Facts::Unversioned
            } else {
                Facts::Missing
            });
        }
        Err(error) => return Err(io_error(format!("Cannot read {}", root.display()), error)),
    };
    if names.iter().all(|name| name == "features.json") {
        return Ok(Facts::Empty);
    }
    if !names.iter().any(|name| name == HOME_FORMAT_FILE) {
        return Ok(Facts::Unversioned);
    }
    let text = match fs::read_to_string(root.join(HOME_FORMAT_FILE)) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::IsADirectory => return Ok(Facts::Unversioned),
        Err(error) => return Err(io_error("Cannot read the format marker", error)),
    };
    let truncated: String = text.chars().take(4096).collect();
    Ok(match marker_version(&truncated) {
        Some(version) => Facts::Versioned(version),
        None => Facts::Unversioned,
    })
}
