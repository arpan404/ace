//! The files and environment Spade's classifier inspects a command's configuration through
//! (ADR 0172, amendment 2): the disk around the folder it starts in, read-only and bounded, and
//! the environment the command will run with. The decision is `spade_classify::inspect`.

use std::path::Path;

use spade_classify::{FileRead, Files};

/// The largest configuration file read; a larger one counts as running something.
const LONGEST: u64 = 256 * 1024;

pub struct Disk {
    /// The environment the command runs with (Spade's, not the daemon's: `HOME` is the bot's
    /// folder, so `~/.gitconfig` is a file in it).
    pub env: Vec<(String, String)>,
}

impl Files for Disk {
    fn read(&self, path: &Path) -> FileRead {
        match std::fs::metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => FileRead::Missing,
            Err(_) => FileRead::Unreadable,
            Ok(meta) if meta.is_dir() => FileRead::Missing,
            Ok(meta) if meta.len() > LONGEST => FileRead::Unreadable,
            Ok(_) => std::fs::read_to_string(path).map_or(FileRead::Unreadable, FileRead::Text),
        }
    }

    fn list(&self, dir: &Path) -> Option<Vec<String>> {
        let entries = std::fs::read_dir(dir).ok()?;
        Some(
            entries
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
        )
    }

    fn var(&self, name: &str) -> Option<String> {
        self.env
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
    }

    fn vars(&self) -> Vec<String> {
        self.env.iter().map(|(n, _)| n.clone()).collect()
    }
}
