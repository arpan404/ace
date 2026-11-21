//! A case's package as a folder on disk, for a door that reads folders: `bot.json`, and each
//! other file by its path. A path that would leave the folder is never written.

use std::path::{Component, Path};

use serde_json::Value;

/// Writes `bot` and `files` (path to text) into a new temporary folder.
pub fn package(bot: &Value, files: &[(String, String)]) -> Result<tempfile::TempDir, String> {
    let folder = tempfile::tempdir().map_err(|e| format!("no temporary folder: {e}"))?;
    write(folder.path(), "bot.json", &bot.to_string())?;
    for (path, text) in files {
        write(folder.path(), path, text)?;
    }
    Ok(folder)
}

/// A case's `files` object as (path, text) pairs; a value that isn't text is left out.
pub fn files(value: &Value) -> Vec<(String, String)> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(path, text)| Some((path.clone(), text.as_str()?.to_owned())))
        .collect()
}

fn write(root: &Path, path: &str, text: &str) -> Result<(), String> {
    let relative = Path::new(path);
    let inside = relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)));
    if !inside {
        return Err(format!("{path} isn't a path inside a package"));
    }
    let to = root.join(relative);
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{path}: {e}"))?;
    }
    std::fs::write(&to, text).map_err(|e| format!("{path}: {e}"))
}
