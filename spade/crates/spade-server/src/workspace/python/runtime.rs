//! A bot's Python runtime folder as Spade reads and writes it, on the host, outside every sandbox
//! (ADR 0220). `control/` holds what Spade wrote (the launcher, the set-up, the lock, the staged
//! scripts and the record of the current generation): no sandboxed run can write it, the set-up
//! included. `generations/<id>/` are the environments, each written only by the set-up run that
//! built it; `cache/` and `pythons/` are uv's. Every folder and file is opened by name without
//! following a link, through directory handles, and Spade writes only in `control/` and to new,
//! empty generation folders it makes itself.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use cap_fs_ext::DirExt;
use cap_std::fs::{Dir, OpenOptions};

use super::super::walk::open_file_no_follow;
use super::generation::{Generation, metadata};

/// The largest control file or package metadata Spade reads.
const LARGEST_READ: u64 = 4 * 1024 * 1024;
/// The record of the current generation, in `control/`.
const RECORD: &str = "generation.json";
/// The generations in the order they were made, in `control/`.
const MADE: &str = "made.txt";

#[derive(Debug, Clone)]
pub struct Runtime {
    pub root: PathBuf,
}

/// `name` under `at`, made when missing, opened without following a link.
fn folder(at: &Dir, name: &str) -> std::io::Result<Dir> {
    match at.create_dir(name) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    at.open_dir_nofollow(name)
}

/// A file's bytes, at most [`LARGEST_READ`], opened without following a link.
fn read(at: &Dir, name: &str) -> std::io::Result<Vec<u8>> {
    let file = open_file_no_follow(at, std::ffi::OsStr::new(name))?;
    let mut bytes = Vec::new();
    file.take(LARGEST_READ + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LARGEST_READ {
        return Err(std::io::Error::other(format!("{name} is too large")));
    }
    Ok(bytes)
}

/// Writes `name` in `at` with `content` when it holds anything else: a new file beside it (never
/// following a link), renamed over it.
fn put(at: &Dir, name: &str, content: &[u8]) -> std::io::Result<()> {
    if read(at, name).is_ok_and(|now| now == content) {
        return Ok(());
    }
    let temporary = format!(".{name}.{}", uuid::Uuid::new_v4().simple());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let written = at.open_with(&temporary, &options).and_then(|mut file| {
        file.write_all(content)?;
        file.sync_all()
    });
    let renamed = written.and_then(|()| at.rename(&temporary, at, name));
    if renamed.is_err() {
        let _ = at.remove_file(&temporary);
    }
    renamed
}

impl Runtime {
    /// The runtime folder, made when missing; its parents are Spade's own.
    fn open(&self) -> std::io::Result<Dir> {
        let (Some(parent), Some(name)) = (self.root.parent(), self.root.file_name()) else {
            return Err(std::io::Error::other("the runtime has no folder"));
        };
        std::fs::create_dir_all(parent)?;
        let parent = Dir::open_ambient_dir(parent, cap_std::ambient_authority())?;
        folder(&parent, &name.to_string_lossy())
    }

    fn control_dir(&self) -> std::io::Result<Dir> {
        folder(&self.open()?, "control")
    }

    pub fn control(&self) -> PathBuf {
        self.root.join("control")
    }

    pub fn environment(&self, id: &str) -> PathBuf {
        self.root.join("generations").join(id)
    }

    /// Writes Spade's control files, each only when it changed.
    pub fn write_control(&self, files: &[(&str, &[u8])]) -> std::io::Result<()> {
        let control = self.control_dir()?;
        for (name, content) in files {
            put(&control, name, content)?;
        }
        Ok(())
    }

    /// Stages `bytes` as `control/scripts/<hash>.<extension>`, the same bytes whenever named.
    pub fn stage(&self, bytes: &[u8], extension: &str) -> std::io::Result<PathBuf> {
        let scripts = folder(&self.control_dir()?, "scripts")?;
        let name = format!("{}.{extension}", super::super::trust::hash(bytes));
        put(&scripts, &name, bytes)?;
        Ok(self.control().join("scripts").join(name))
    }

    /// Whether `path` is a staged file still holding the bytes it was staged with.
    pub fn staged_intact(&self, path: &Path) -> bool {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            return false;
        };
        if path.parent() != Some(self.control().join("scripts").as_path()) {
            return false;
        }
        let Some(hash) = name.split('.').next() else {
            return false;
        };
        self.control_dir()
            .and_then(|control| control.open_dir_nofollow("scripts"))
            .and_then(|scripts| read(&scripts, &name))
            .is_ok_and(|bytes| super::super::trust::hash(&bytes) == hash)
    }

    /// The current generation, as recorded.
    pub fn current(&self) -> Option<Generation> {
        let bytes = read(&self.control_dir().ok()?, RECORD).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Makes a new, empty generation folder and uv's folders. Answers its id and the folders its
    /// set-up run may write.
    pub fn begin(&self) -> std::io::Result<(String, Vec<PathBuf>)> {
        let root = self.open()?;
        let generations = folder(&root, "generations")?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        generations.create_dir(&id)?;
        folder(&root, "cache")?;
        folder(&root, "pythons")?;
        let control = self.control_dir()?;
        let mut made = read(&control, MADE).unwrap_or_default();
        made.extend_from_slice(format!("{id}\n").as_bytes());
        put(&control, MADE, &made)?;
        Ok((
            id.clone(),
            vec![
                self.environment(&id),
                self.root.join("cache"),
                self.root.join("pythons"),
            ],
        ))
    }

    /// What generation `id` resolved and has installed, read through its folders without
    /// following a link: its `resolved.txt` (empty without one) and every package's metadata.
    pub fn installed(&self, id: &str) -> std::io::Result<(String, BTreeMap<String, String>)> {
        let environment = self
            .open()?
            .open_dir_nofollow("generations")?
            .open_dir_nofollow(id)?;
        let resolved = read(&environment, "resolved.txt")
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        let mut installed = BTreeMap::new();
        let Ok(lib) = environment.open_dir_nofollow("lib") else {
            return Ok((resolved, installed));
        };
        for version in lib.entries()?.filter_map(Result::ok) {
            let Ok(packages) = lib
                .open_dir_nofollow(version.file_name())
                .and_then(|v| v.open_dir_nofollow("site-packages"))
            else {
                continue;
            };
            for entry in packages.entries()?.filter_map(Result::ok) {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.ends_with(".dist-info") {
                    continue;
                }
                let Ok(info) = packages.open_dir_nofollow(&name) else {
                    continue;
                };
                if let Ok(bytes) = read(&info, "METADATA")
                    && let Some((package, version)) = metadata(&String::from_utf8_lossy(&bytes))
                {
                    installed.insert(package, version);
                }
            }
        }
        Ok((resolved, installed))
    }

    /// Makes `generation` the current one (one rename), then deletes all but the newest `keep`.
    pub fn switch(&self, generation: &Generation, keep: usize) -> std::io::Result<()> {
        let control = self.control_dir()?;
        let record = serde_json::to_vec(generation).map_err(std::io::Error::other)?;
        put(&control, RECORD, &record)?;
        let made: Vec<String> = String::from_utf8_lossy(&read(&control, MADE).unwrap_or_default())
            .lines()
            .map(str::to_owned)
            .collect();
        let stale = super::generation::stale(&made, &generation.id, keep);
        for id in &stale {
            self.discard(id);
        }
        let left: String = made
            .iter()
            .filter(|id| !stale.contains(id))
            .map(|id| format!("{id}\n"))
            .collect();
        put(&control, MADE, left.as_bytes())
    }

    /// Deletes generation `id` (links in it are removed, never followed).
    pub fn discard(&self, id: &str) {
        if let Ok(generations) = self.open().and_then(|r| r.open_dir_nofollow("generations")) {
            let _ = generations.remove_dir_all(id);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn control_files_are_written_through_handles_and_never_through_a_link() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let runtime = Runtime {
            root: root.path().join(".python/b1"),
        };
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, "theirs").unwrap_or_default();
        runtime
            .write_control(&[("run.sh", b"one")])
            .unwrap_or_else(|e| panic!("{e}"));
        // A link put where a control file is: replaced, never written through.
        let control = runtime.control();
        std::fs::remove_file(control.join("run.sh")).unwrap_or_default();
        std::os::unix::fs::symlink(&outside, control.join("run.sh")).unwrap_or_default();
        runtime
            .write_control(&[("run.sh", b"two")])
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            std::fs::read_to_string(&outside).ok().as_deref(),
            Some("theirs")
        );
        assert_eq!(
            std::fs::read_to_string(control.join("run.sh"))
                .ok()
                .as_deref(),
            Some("two")
        );
        // A scripts folder swapped for a link to elsewhere is never staged into.
        let elsewhere = root.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap_or_default();
        std::os::unix::fs::symlink(&elsewhere, control.join("scripts")).unwrap_or_default();
        assert!(runtime.stage(b"print(1)", "py").is_err());
        assert_eq!(
            std::fs::read_dir(&elsewhere)
                .map(|d| d.count())
                .unwrap_or(0),
            0
        );
    }

    #[test]
    fn a_staged_file_counts_only_while_it_holds_its_bytes() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let runtime = Runtime {
            root: root.path().join(".python/b1"),
        };
        let staged = runtime
            .stage(b"print(1)", "py")
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(runtime.staged_intact(&staged));
        std::fs::write(&staged, "print(2)").unwrap_or_default();
        assert!(!runtime.staged_intact(&staged));
        assert!(!runtime.staged_intact(&root.path().join("x.py")));
    }
}
