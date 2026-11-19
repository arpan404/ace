//! Executables the agent named by path, remembered across helper processes so the app's own
//! helper can start one that the catalog helper resolved. Kept as one small JSON file in the
//! data directory the daemon passes (`--data-dir`). Pure apart from the file read and write.
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

const FILE: &str = "computer-executables.json";
const LIMIT: usize = 200;

pub struct Known {
    file: Option<PathBuf>,
}

/// The `--data-dir <dir>` (or `--data-dir=<dir>`) argument, if given and absolute.
pub fn data_dir_arg(args: impl Iterator<Item = String>) -> Option<PathBuf> {
    let mut args = args.peekable();
    let mut found = None;
    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--data-dir=") {
            found = Some(value.to_owned());
        } else if arg == "--data-dir" {
            found = args.next();
        }
    }
    found.map(PathBuf::from).filter(|path| path.is_absolute())
}

impl Known {
    pub fn new(dir: Option<&Path>) -> Self {
        Self {
            file: dir.map(|dir| dir.join(FILE)),
        }
    }

    fn read(&self) -> Map<String, Value> {
        self.file
            .as_ref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| match value {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub fn path(&self, id: &str) -> Option<String> {
        self.read()
            .get(&id.to_lowercase())
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    pub fn remember(&self, id: &str, path: &str) {
        let Some(file) = &self.file else { return };
        let mut map = self.read();
        map.remove(&id.to_lowercase());
        while map.len() >= LIMIT {
            let Some(oldest) = map.keys().next().cloned() else {
                break;
            };
            map.remove(&oldest);
        }
        map.insert(id.to_lowercase(), Value::String(path.to_owned()));
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let temporary = file.with_extension(format!("{}.tmp", std::process::id()));
        if std::fs::write(&temporary, Value::Object(map).to_string()).is_ok() {
            let _ = std::fs::rename(&temporary, file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_data_dir_comes_from_either_argument_form_and_must_be_absolute() {
        let args = |list: &[&str]| {
            list.iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .into_iter()
        };
        let absolute = std::env::temp_dir().join("ace-screen");
        let given = absolute.to_string_lossy().to_string();
        assert_eq!(
            data_dir_arg(args(&["--computer", "--data-dir", &given])),
            Some(absolute.clone())
        );
        assert_eq!(
            data_dir_arg(args(&[&format!("--data-dir={given}"), "--computer"])),
            Some(absolute)
        );
        assert_eq!(
            data_dir_arg(args(&["--computer", "--data-dir", "relative"])),
            None
        );
        assert_eq!(data_dir_arg(args(&["--computer"])), None);
    }

    #[test]
    fn a_resolved_path_is_known_to_another_process_reading_the_same_directory() {
        let dir = std::env::temp_dir().join(format!("ace-known-{}", std::process::id()));
        let writer = Known::new(Some(&dir));
        writer.remember("Fixture.exe", r"C:\tools\Fixture.exe");
        let reader = Known::new(Some(&dir));
        assert_eq!(
            reader.path("fixture.exe").as_deref(),
            Some(r"C:\tools\Fixture.exe")
        );
        assert_eq!(reader.path("other.exe"), None);
        assert_eq!(Known::new(None).path("fixture.exe"), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
