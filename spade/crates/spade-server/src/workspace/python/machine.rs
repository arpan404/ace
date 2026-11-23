//! The machine's Python, built by Spade itself on the host (ADR 0220), never in a bot's
//! sandbox: one environment per lock Spade ships, shared by every bot. Its folder,
//! `<workspaces>/.python/shared/`, is Spade's alone; bots' runs read `control/`,
//! `environments/` and `pythons/` and write nothing here.
//!
//! An environment is built in a new folder with uv (the pinned CPython, then exactly the lock:
//! `--no-deps --require-hashes`, binary wheels, one index), checked against the lock (every
//! installed package locked at its version, the wanted ones there, no `.pth` start-up file),
//! made read-only, and moved into place with one rename. The record of the current one
//! (`current.json`) is replaced with one rename after that, and nothing is ever deleted before it
//! is written, so a failure at any step leaves the record naming a whole environment. A run holds
//! a shared lock on its environment's lease file for as long as it runs; an old environment is
//! deleted only when Spade can take that lock exclusively, so never under a running script.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use cap_fs_ext::DirExt;

use super::environment::{self, Current};
use super::staging::{folder, open, put, read};
use super::vetting::{Places, vet};
use super::{BOOT, Index, LAUNCHER, NAMES, Setup};

/// The record of the current environment.
const RECORD: &str = "current.json";
/// How long one build may take (a CPython download and the packages).
const BUILD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Where environments are built before they are moved into place.
const BUILDING: &str = ".building-";

/// The machine's shared Python folder.
#[derive(Debug, Clone)]
pub struct Machine {
    pub root: PathBuf,
}

/// A run's hold on an environment: released when dropped.
#[derive(Debug)]
pub struct Lease {
    _file: std::fs::File,
}

/// The programs a build may run, vetted, and what Spade said about any it wouldn't use.
#[derive(Debug, Clone, Default)]
pub struct Tools {
    pub uv: Option<PathBuf>,
    /// Vetted Pythons, newest name first; the first that is 3.10 or newer is used.
    pub pythons: Vec<PathBuf>,
    pub notes: Vec<String>,
}

impl Tools {
    /// The first vetted Python that is 3.10 or newer, checked by running it with `-I -S` and
    /// nothing of Spade's environment. Blocking.
    fn python(&self) -> Option<PathBuf> {
        self.pythons
            .iter()
            .find(|path| {
                std::process::Command::new(path)
                    .args([
                        "-I",
                        "-S",
                        "-c",
                        "import sys; sys.exit(sys.version_info < (3, 10))",
                    ])
                    .env_clear()
                    .status()
                    .is_ok_and(|status| status.success())
            })
            .cloned()
    }
}

/// What a build said, for the call that waited on it.
pub type Said = String;

impl Machine {
    pub fn control(&self) -> PathBuf {
        self.root.join("control")
    }

    pub fn environment(&self, name: &str) -> PathBuf {
        self.root.join("environments").join(name)
    }

    /// Writes the launcher and `boot.py`, each only when it changed.
    pub fn write_control(&self) -> std::io::Result<()> {
        let control = folder(&open(&self.root)?, "control")?;
        put(&control, "run.sh", LAUNCHER.as_bytes())?;
        put(&control, "boot.py", BOOT.as_bytes())
    }

    /// The environment recorded as current.
    pub fn current(&self) -> Option<Current> {
        let bytes = read(&open(&self.root).ok()?, RECORD).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Records `name` as the current environment (one rename).
    pub fn publish(&self, name: &str) -> std::io::Result<()> {
        let record = serde_json::to_vec(&Current {
            environment: name.to_owned(),
        })
        .map_err(std::io::Error::other)?;
        put(&open(&self.root)?, RECORD, &record)
    }

    /// Whether environment `name` is in place, with its Python.
    pub fn usable(&self, name: &str) -> bool {
        open(&self.root)
            .and_then(|root| root.open_dir_nofollow("environments"))
            .and_then(|all| all.open_dir_nofollow(name))
            .and_then(|environment| environment.open_dir_nofollow("bin"))
            .and_then(|bin| bin.symlink_metadata("python"))
            .is_ok()
    }

    /// Held while an environment is checked, built, published or swept: one at a time on the
    /// machine, whichever Spade or tool asks. Blocking.
    pub fn exclusive(&self) -> std::io::Result<std::fs::File> {
        let file = self.lock_file("build.lock")?;
        file.lock()?;
        Ok(file)
    }

    fn lock_file(&self, name: &str) -> std::io::Result<std::fs::File> {
        let leases = self.root.join("leases");
        std::fs::create_dir_all(&leases)?;
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(leases.join(name))
    }

    /// A run's hold on environment `name`, until the lease is dropped. Blocking.
    pub fn lease(&self, name: &str) -> std::io::Result<Lease> {
        let file = self.lock_file(&format!("{name}.lock"))?;
        file.lock_shared()?;
        Ok(Lease { _file: file })
    }

    /// Deletes every environment but `keep` that no run holds, and what an interrupted build
    /// left. Under [`Machine::exclusive`].
    pub fn sweep(&self, keep: &str) {
        let Ok(names) = std::fs::read_dir(self.root.join("environments")) else {
            return;
        };
        for entry in names.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == keep {
                continue;
            }
            if !name.starts_with(BUILDING) {
                let Ok(lease) = self.lock_file(&format!("{name}.lock")) else {
                    continue;
                };
                // Held by a running script: kept until the next sweep.
                if lease.try_lock().is_err() {
                    continue;
                }
                remove(&self.environment(&name));
                drop(lease);
                continue;
            }
            remove(&self.environment(&name));
        }
    }

    /// The programs a build may run, found once in `setup`'s folders and vetted
    /// ([`super::vetting::vet`]): uv, and the Pythons by name, newest first (nothing is run here).
    /// Blocking.
    pub fn tools(&self, setup: &Setup, places: &Places) -> Tools {
        let mut notes = Vec::new();
        let mut vetted = |path: PathBuf| match vet(&path, places) {
            Ok(resolved) => Some(resolved),
            Err(why) => {
                notes.push(format!("Spade didn't use {}: {why}.", path.display()));
                None
            }
        };
        let uv = setup
            .folders
            .iter()
            .map(|folder| folder.join("uv"))
            .filter(|path| path.exists())
            .find_map(&mut vetted);
        let pythons = NAMES
            .iter()
            .flat_map(|name| setup.folders.iter().map(move |folder| folder.join(name)))
            .filter(|path| path.exists())
            .filter_map(&mut vetted)
            .collect();
        Tools { uv, pythons, notes }
    }

    /// Builds environment `name` with `tools` (with uv when there is one, else the standard
    /// library alone) and moves it into place. Answers what it said, or why it failed (nothing is
    /// left behind). Under [`Machine::exclusive`].
    pub async fn build(&self, setup: &Setup, name: &str, tools: &Tools) -> Result<Said, String> {
        let building = self.environment(&format!("{BUILDING}{}", uuid::Uuid::new_v4().simple()));
        let built = self.build_in(setup, &building, tools).await;
        let placed = built.and_then(|said| {
            read_only(&building).map_err(|e| format!("couldn't make it read-only: {e}"))?;
            let target = self.environment(name);
            if target.exists() {
                remove(&target);
            }
            std::fs::rename(&building, &target)
                .map_err(|e| format!("couldn't move it into place: {e}"))?;
            Ok(said)
        });
        if placed.is_err() {
            remove(&building);
        }
        placed
    }

    async fn build_in(
        &self,
        setup: &Setup,
        building: &Path,
        tools: &Tools,
    ) -> Result<Said, String> {
        for place in ["cache", "pythons", "home", "locks"] {
            std::fs::create_dir_all(self.root.join(place)).map_err(|e| e.to_string())?;
        }
        let env = self.environment_variables(setup);
        let target = building.to_string_lossy().into_owned();
        let looked: Vec<String> = setup
            .folders
            .iter()
            .map(|f| f.to_string_lossy().into_owned())
            .collect();
        let none = || {
            let mut why = format!(
                "No Python 3.10 or newer was found on this machine (looked for uv and python3 in \
                 {}). The person can install one, for example with Homebrew: brew install python.",
                looked.join(", ")
            );
            for note in &tools.notes {
                why.push(' ');
                why.push_str(note);
            }
            why
        };
        // Which programs made it, for the result.
        let mut used = Vec::new();
        if let Some(uv) = &tools.uv {
            used.push(format!("uv {}", uv.display()));
            let mut made = false;
            if let Some(version) = &setup.pinned {
                let args = [
                    "venv",
                    "--no-config",
                    "--quiet",
                    "--managed-python",
                    "--python",
                    version,
                ];
                made = self.run(uv, &args, &[&target], &env).await.is_ok();
                if made {
                    used.push(format!("uv's own CPython {version}"));
                }
            }
            if !made {
                // Never one uv finds by itself: only the Python Spade vetted.
                let python = tools.python().ok_or_else(none)?;
                let shown = python.to_string_lossy().into_owned();
                let args = [
                    "venv",
                    "--no-config",
                    "--quiet",
                    "--no-python-downloads",
                    "--python",
                    &shown,
                ];
                self.run(uv, &args, &[&target], &env)
                    .await
                    .map_err(|why| format!("no Python 3.10 or newer could be had: {why}"))?;
                used.push(format!("Python {shown}"));
            }
        } else {
            let python = tools.python().ok_or_else(none)?;
            // Without `site`: nothing of that Python's own packages runs as Spade.
            self.run(
                &python,
                &["-I", "-S", "-m", "venv", "--without-pip"],
                &[&target],
                &env,
            )
            .await?;
            used.push(format!("Python {}", python.display()));
        }
        // uv's own start-up hook: nothing runs at start but boot.py.
        for packages in site_packages(building) {
            let _ = std::fs::remove_file(packages.join("_virtualenv.pth"));
            let _ = std::fs::remove_file(packages.join("_virtualenv.py"));
        }
        let python = building.join("bin/python");
        let version = self
            .run(
                &python,
                &[
                    "-I",
                    "-S",
                    "-c",
                    "import platform; print(platform.python_version())",
                ],
                &[],
                &env,
            )
            .await?;
        let mut notes = tools.notes.join(" ");
        if !notes.is_empty() {
            notes.insert(0, ' ');
        }
        let used = used.join(", ");
        let Some(uv) = &tools.uv else {
            return Ok(format!(
                "[Set up Python for Spade's bots: {version}, with its standard library only: uv \
                 isn't on this machine, and Spade installs packages only with uv. The person can \
                 install it, for example with Homebrew: brew install uv. Made with {used}.{notes}]"
            ));
        };
        let digest = super::trust_hash(setup.lock.as_bytes());
        let locks = open(&self.root.join("locks")).map_err(|e| e.to_string())?;
        let lock_name = format!("{digest}.txt");
        put(&locks, &lock_name, setup.lock.as_bytes()).map_err(|e| e.to_string())?;
        let lock_path = self.root.join("locks").join(&lock_name);
        let mut args: Vec<String> = ["pip", "install", "--no-config", "--quiet", "--python"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        args.push(python.to_string_lossy().into_owned());
        args.extend(["--only-binary", ":all:"].map(str::to_owned));
        match &setup.index {
            Index::Url(url) => args.extend(["--index-url".to_owned(), url.clone()]),
            Index::Folder(folder) => args.extend([
                "--no-index".to_owned(),
                "--find-links".to_owned(),
                folder.to_string_lossy().into_owned(),
            ]),
        }
        args.extend(["--no-deps", "--require-hashes", "-r"].map(str::to_owned));
        args.push(lock_path.to_string_lossy().into_owned());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run(uv, &refs, &[], &env)
            .await
            .map_err(|why| format!("the locked packages couldn't be installed: {why}"))?;
        let (installed, files) = installed(building).map_err(|e| e.to_string())?;
        let wanted: Vec<&str> = setup.wanted.iter().map(String::as_str).collect();
        environment::check(&environment::pins(&setup.lock), &installed, &wanted, &files)
            .map_err(|why| format!("Spade checked what was installed and didn't use it: {why}"))?;
        Ok(format!(
            "[Set up Python for Spade's bots: {version}, with {}. Made with {used}.{notes}]",
            setup.wanted.join(", ")
        ))
    }

    /// The build's whole environment: nothing of Spade's own but what it passes on.
    fn environment_variables(&self, setup: &Setup) -> Vec<(String, String)> {
        let path = setup
            .folders
            .iter()
            .map(|f| f.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(":");
        let root = |name: &str| self.root.join(name).to_string_lossy().into_owned();
        let mut env = vec![
            ("PATH".to_owned(), path),
            ("HOME".to_owned(), root("home")),
            ("UV_NO_CONFIG".to_owned(), "1".to_owned()),
            ("UV_NO_PROGRESS".to_owned(), "1".to_owned()),
            ("UV_LINK_MODE".to_owned(), "copy".to_owned()),
            ("UV_CACHE_DIR".to_owned(), root("cache")),
            ("UV_PYTHON_INSTALL_DIR".to_owned(), root("pythons")),
            ("PYTHONNOUSERSITE".to_owned(), "1".to_owned()),
        ];
        env.extend(setup.env.iter().cloned());
        env
    }

    /// Runs `program` with `args` then `tail` in the shared folder, with only `env`. Answers its
    /// output, or what it said when it failed.
    async fn run(
        &self,
        program: &Path,
        args: &[&str],
        tail: &[&str],
        env: &[(String, String)],
    ) -> Result<String, String> {
        let mut command = tokio::process::Command::new(program);
        command
            .args(args)
            .args(tail)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .current_dir(&self.root)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        let output = tokio::time::timeout(BUILD_TIMEOUT, command.output())
            .await
            .map_err(|_| "it took too long".to_owned())?
            .map_err(|e| e.to_string())?;
        let said = |bytes: &[u8]| String::from_utf8_lossy(bytes).trim().to_owned();
        if output.status.success() {
            Ok(said(&output.stdout))
        } else {
            Err(
                format!("{}\n{}", said(&output.stdout), said(&output.stderr))
                    .trim()
                    .to_owned(),
            )
        }
    }
}

/// The installed-packages folders of the environment at `root`.
fn site_packages(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root.join("lib"))
        .map(|versions| {
            versions
                .filter_map(Result::ok)
                .map(|v| v.path().join("site-packages"))
                .filter(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()))
                .collect()
        })
        .unwrap_or_default()
}

/// What the environment at `root` has installed, by normalised name, and the top-level names in
/// its installed-packages folders, each read through no-follow handles.
fn installed(root: &Path) -> std::io::Result<(BTreeMap<String, String>, Vec<String>)> {
    let mut installed = BTreeMap::new();
    let mut files = Vec::new();
    for packages in site_packages(root) {
        let at = cap_std::fs::Dir::open_ambient_dir(&packages, cap_std::ambient_authority())?;
        for entry in at.entries()?.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".dist-info")
                && let Ok(info) = at.open_dir_nofollow(&name)
                && let Ok(bytes) = read(&info, "METADATA")
                && let Some((package, version)) =
                    environment::metadata(&String::from_utf8_lossy(&bytes))
            {
                installed.insert(package, version);
            }
            files.push(name);
        }
    }
    Ok((installed, files))
}

/// Makes the tree at `root` read-only (links left as they are, never followed).
fn read_only(root: &Path) -> std::io::Result<()> {
    set_writable(root, false)
}

#[cfg(not(unix))]
fn set_writable(_root: &Path, _writable: bool) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_writable(root: &Path, writable: bool) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::symlink_metadata(root)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() && writable {
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o755))?;
    }
    if meta.is_dir() {
        for entry in std::fs::read_dir(root)? {
            set_writable(&entry?.path(), writable)?;
        }
    }
    let mode = meta.permissions().mode();
    let wanted = if writable {
        mode | 0o200
    } else {
        mode & !0o222
    };
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(wanted))
}

/// Deletes the tree at `root`, made writable first (links removed, never followed).
fn remove(root: &Path) {
    let _ = set_writable(root, true);
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn machine(root: &Path) -> Machine {
        Machine {
            root: root.join("shared"),
        }
    }

    fn fake_environment(machine: &Machine, name: &str) {
        let bin = machine.environment(name).join("bin");
        std::fs::create_dir_all(&bin).unwrap_or_default();
        std::fs::write(bin.join("python"), "").unwrap_or_default();
        read_only(&machine.environment(name)).unwrap_or_default();
    }

    #[test]
    fn a_failed_record_write_leaves_the_record_naming_the_old_whole_environment() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let machine = machine(root.path());
        fake_environment(&machine, "old");
        machine.publish("old").unwrap_or_else(|e| panic!("{e}"));
        fake_environment(&machine, "new");
        // The record's folder refuses new files: the switch can't be written.
        std::fs::set_permissions(&machine.root, std::fs::Permissions::from_mode(0o555))
            .unwrap_or_default();
        let switched = machine.publish("new");
        std::fs::set_permissions(&machine.root, std::fs::Permissions::from_mode(0o755))
            .unwrap_or_default();
        assert!(switched.is_err());
        let current = machine.current().map(|c| c.environment);
        assert_eq!(current.as_deref(), Some("old"));
        assert!(machine.usable("old"));
    }

    #[test]
    fn an_old_environment_is_deleted_only_once_no_run_holds_it() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let machine = machine(root.path());
        fake_environment(&machine, "old");
        fake_environment(&machine, "new");
        std::fs::create_dir_all(machine.environment(".building-x")).unwrap_or_default();
        let held = machine.lease("old").unwrap_or_else(|e| panic!("{e}"));
        machine.sweep("new");
        assert!(machine.usable("old"), "deleted under a running script");
        assert!(!machine.environment(".building-x").exists());
        drop(held);
        machine.sweep("new");
        assert!(!machine.environment("old").exists());
        assert!(machine.usable("new"));
    }
}
