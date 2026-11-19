//! The folder a bot's command runs in, as the shell classifier asks about it (ADR 0144): real
//! paths with symlinks followed, containment in the bot's workspace, and the files it runs.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use spade_core::autonomy::shell::{Place, Program, Unseen};

pub struct FsPlace {
    /// Where the command starts.
    cwd: PathBuf,
    /// The bot's workspace, with its own symlinks followed.
    root: PathBuf,
    /// The `PATH` the command starts with; `None` finds no program.
    path: Option<String>,
    /// Windows: the endings cmd.exe tries, in order (`PATHEXT`), and the system's folder.
    pathext: Option<String>,
    system_root: Option<String>,
}

impl FsPlace {
    /// `None` when the workspace itself can't be resolved: then nothing can be said to be in it.
    pub fn new(cwd: PathBuf, workspace: &Path) -> Option<Self> {
        let root = std::fs::canonicalize(workspace).ok()?;
        Some(Self {
            cwd,
            root,
            path: None,
            pathext: None,
            system_root: None,
        })
    }

    /// Finding programs as the command's shell will, from the environment it starts with.
    pub fn with_env(mut self, env: &[(String, String)]) -> Self {
        let var = |name: &str| {
            env.iter()
                .rev()
                .find(|(n, _)| n.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
        };
        self.path = var("PATH");
        self.pathext = var("PATHEXT");
        self.system_root = var("SystemRoot");
        self
    }

    /// Where `name` (a bare name, or a path) runs from, as a real path.
    fn locate(&self, name: &str) -> Option<PathBuf> {
        if name.contains('/') || name.contains('\\') {
            return std::fs::canonicalize(name).ok();
        }
        #[cfg(windows)]
        let found = cmd_lookup(
            name,
            &self.cwd,
            self.path.as_deref()?,
            self.pathext.as_deref()?,
            &|file| file.is_file(),
        );
        #[cfg(not(windows))]
        let found = sh_lookup(name, self.path.as_deref()?, &runnable);
        std::fs::canonicalize(found?).ok()
    }
}

/// Where `sh` runs the bare `name` from: the first `PATH` entry with a runnable file of that name.
/// `None` when there is none, or an entry before it is empty or relative (looked up from wherever
/// the shell is then: Spade can't follow that).
#[cfg_attr(windows, allow(dead_code))]
fn sh_lookup(name: &str, path: &str, runnable: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    for dir in std::env::split_paths(path) {
        if dir.as_os_str().is_empty() || dir.is_relative() {
            return None;
        }
        let file = dir.join(name);
        if runnable(&file) {
            return Some(file);
        }
    }
    None
}

/// Where cmd.exe runs the bare `name` from, only where that can't be in doubt (ADR 0171,
/// amendment 6): `None` when a file it could take for `name` is in the folder the command starts
/// in (cmd.exe looks there first), when `PATHEXT` is empty or `PATH` has an empty or relative
/// entry, or when nothing matches. Otherwise the first `PATH` folder, in order, with `name` as
/// written (when its ending is one `PATHEXT` lists) or with `PATHEXT`'s endings in order.
#[cfg_attr(not(windows), allow(dead_code))]
fn cmd_lookup(
    name: &str,
    cwd: &Path,
    path: &str,
    pathext: &str,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let endings: Vec<String> = pathext
        .split(';')
        .map(str::trim)
        .filter(|e| e.starts_with('.') && e.len() > 1)
        .map(str::to_ascii_lowercase)
        .collect();
    if endings.is_empty() || name.contains(':') {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    let has_ending = endings.iter().any(|e| lower.ends_with(e.as_str()));
    // Any file cmd.exe could take for it, with or without an ending of `PATHEXT`'s.
    let mut names: Vec<String> = endings.iter().map(|e| format!("{name}{e}")).collect();
    if has_ending {
        names.insert(0, name.to_owned());
    }
    if names
        .iter()
        .chain([&name.to_owned()])
        .any(|n| exists(&cwd.join(n)))
    {
        return None;
    }
    let tried: Vec<String> = if has_ending {
        vec![name.to_owned()]
    } else {
        names
    };
    for dir in path.split(';') {
        let dir = Path::new(dir.trim());
        if dir.as_os_str().is_empty() || dir.is_relative() {
            return None;
        }
        if let Some(file) = tried.iter().map(|n| dir.join(n)).find(|f| exists(f)) {
            return Some(file);
        }
    }
    None
}

/// Whether `file` is a program the shell would start.
#[cfg_attr(windows, allow(dead_code))]
fn runnable(file: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(file) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// The folders the operating system protects, whose programs need no binding: macOS's
/// `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin` and `/System` (sealed); Linux's first four, when
/// root's and writable by no one else. Never Homebrew's, `/usr/local`, `/opt`, `/nix` or `/snap`.
#[cfg(unix)]
const PROTECTED: &[&str] = if cfg!(target_os = "macos") {
    &["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/System"]
} else {
    &["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
};

/// Whether the program at the real path `real` is the operating system's own: under a folder it
/// protects, and on Linux, it and its folder root's and writable by no one else.
#[cfg(unix)]
fn system_owned(real: &Path, _system_root: Option<&str>) -> bool {
    if !PROTECTED.iter().any(|dir| real.starts_with(dir)) {
        return false;
    }
    if cfg!(target_os = "macos") {
        return true;
    }
    use std::os::unix::fs::MetadataExt;
    let root_only = |path: &Path| {
        std::fs::metadata(path).is_ok_and(|meta| meta.uid() == 0 && meta.mode() & 0o022 == 0)
    };
    root_only(real) && real.parent().is_some_and(root_only)
}

/// Windows: only `%SystemRoot%\\System32`'s own programs.
#[cfg(not(unix))]
fn system_owned(real: &Path, system_root: Option<&str>) -> bool {
    let Some(system32) = system_root
        .map(|root| Path::new(root).join("System32"))
        .and_then(|dir| std::fs::canonicalize(dir).ok())
    else {
        return false;
    };
    real.starts_with(system32)
}

/// The most of a program Spade reads to bind a call to it; a larger one can't be bound.
pub const LONGEST_PROGRAM: u64 = 512 * 1024 * 1024;

/// The SHA-256 of `real`'s content, read whole; `None` on any error or past `longest`.
fn digest(real: &Path, longest: u64) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(real).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > longest {
        return None;
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut total: u64 = 0;
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > longest {
            return None;
        }
        hasher.update(&buffer[..read]);
    }
    Some(
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

impl Place for FsPlace {
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        let path = Path::new(path);
        let joined = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.cwd.join(path)
        };
        let parts: Vec<Component<'_>> = joined.components().collect();
        // The longest part that exists, with its links followed; the rest as written.
        for end in (1..=parts.len()).rev() {
            let prefix: PathBuf = parts[..end].iter().collect();
            if std::fs::symlink_metadata(&prefix).is_err() {
                continue;
            }
            // It exists but can't be followed (a broken link, no permission): unknown.
            let mut real = std::fs::canonicalize(&prefix).ok()?;
            for part in &parts[end..] {
                match part {
                    Component::ParentDir => {
                        real.pop();
                    }
                    Component::CurDir => {}
                    Component::Normal(name) => real.push(name),
                    Component::RootDir | Component::Prefix(_) => return None,
                }
            }
            return Some(real);
        }
        None
    }

    fn contains(&self, real: &Path) -> bool {
        real.starts_with(&self.root)
    }

    fn program(&self, name: &str) -> Program {
        let Some(real) = self.locate(name) else {
            return Program::Missing;
        };
        if self.contains(&real) {
            return Program::At(real);
        }
        if system_owned(&real, self.system_root.as_deref()) {
            return Program::System;
        }
        Program::At(real)
    }

    fn digest(&self, real: &Path) -> Option<String> {
        digest(real, LONGEST_PROGRAM)
    }

    fn read(&self, real: &Path, longest: usize) -> Result<String, Unseen> {
        let file = std::fs::File::open(real).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => Unseen::Missing,
            _ => Unseen::Unreadable,
        })?;
        let mut bytes = Vec::new();
        file.take(longest as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Unseen::Unreadable)?;
        if bytes.len() > longest {
            return Err(Unseen::TooLarge);
        }
        String::from_utf8(bytes).map_err(|_| Unseen::Unreadable)
    }

    fn list(&self, real: &Path) -> Result<Vec<String>, Unseen> {
        let entries = std::fs::read_dir(real).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => Unseen::Missing,
            _ => Unseen::Unreadable,
        })?;
        Ok(entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_link_inside_the_workspace_to_elsewhere_resolves_elsewhere() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let workspace = dir.path().join("w");
        let other = dir.path().join("other");
        std::fs::create_dir_all(workspace.join("src")).unwrap_or_else(|e| panic!("{e}"));
        std::fs::create_dir_all(&other).unwrap_or_else(|e| panic!("{e}"));
        std::os::unix::fs::symlink(&other, workspace.join("out")).unwrap_or_else(|e| panic!("{e}"));
        std::os::unix::fs::symlink(dir.path().join("gone"), workspace.join("broken"))
            .unwrap_or_else(|e| panic!("{e}"));
        let place = FsPlace::new(workspace.join("src"), &workspace).unwrap_or_else(|| panic!());
        let inside = |path: &str| place.resolve(path).map(|real| place.contains(&real));
        assert_eq!(inside("new/file.txt"), Some(true));
        assert_eq!(inside("../out/file.txt"), Some(false));
        assert_eq!(inside("../../file.txt"), Some(false));
        assert_eq!(
            inside("../broken/file.txt"),
            None,
            "a broken link can't be followed"
        );
    }
}

/// cmd.exe's lookup is a pure function of what exists, so it is checked on every platform.
#[cfg(test)]
mod cmd {
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};

    use super::cmd_lookup;

    /// An absolute folder on the platform the test runs on.
    fn at(name: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!("C:\\{name}"))
        } else {
            PathBuf::from(format!("/{name}"))
        }
    }

    fn lookup(name: &str, path: &[&str], files: &[PathBuf]) -> Option<PathBuf> {
        let files: HashSet<PathBuf> = files.iter().cloned().collect();
        let path: Vec<String> = path.iter().map(|p| p.to_string()).collect();
        cmd_lookup(
            name,
            &at("work"),
            &path.join(";"),
            ".COM;.EXE;.BAT;.CMD",
            &|file: &Path| files.contains(file),
        )
    }

    #[test]
    fn a_program_cmd_exe_would_take_from_the_starting_folder_is_never_resolved() {
        let tools = at("tools");
        let tools = tools.to_string_lossy();
        let on_path = at("tools").join("git.exe");
        assert_eq!(
            lookup("git", &[&tools], std::slice::from_ref(&on_path)),
            Some(on_path.clone())
        );
        // The same name in the folder the command starts in shadows `PATH` for cmd.exe: refused.
        for shadow in ["git.exe", "git.bat", "git.cmd", "git"] {
            let files = [on_path.clone(), at("work").join(shadow)];
            assert_eq!(lookup("git", &[&tools], &files), None, "{shadow}");
        }
    }

    #[test]
    fn cmd_exe_s_order_is_path_then_pathext() {
        let (first, second) = (at("first"), at("second"));
        let (a, b) = (first.to_string_lossy(), second.to_string_lossy());
        // In one folder, `PATHEXT`'s order: `.EXE` before `.BAT`.
        let files = [second.join("tool.bat"), second.join("tool.exe")];
        assert_eq!(
            lookup("tool", &[&a, &b], &files),
            Some(second.join("tool.exe"))
        );
        // An earlier `PATH` folder wins whatever its ending.
        let files = [first.join("tool.cmd"), second.join("tool.exe")];
        assert_eq!(
            lookup("tool", &[&a, &b], &files),
            Some(first.join("tool.cmd"))
        );
        // Named with an ending `PATHEXT` lists: that file only.
        let files = [first.join("tool.exe"), first.join("tool.exe.com")];
        assert_eq!(
            lookup("tool.exe", &[&a], &files),
            Some(first.join("tool.exe"))
        );
        // An empty or relative entry before a match, or nothing at all: refused.
        let files = [second.join("tool.exe")];
        assert_eq!(lookup("tool", &["", &b], &files), None);
        assert_eq!(lookup("tool", &["bin", &b], &files), None);
        assert_eq!(lookup("missing", &[&a, &b], &files), None);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod exempt {
    use std::path::Path;

    use super::system_owned;

    #[test]
    fn only_a_real_path_in_a_folder_the_system_protects_is_the_systems() {
        // The system's own, root's and writable by no one else.
        let env = std::fs::canonicalize("/usr/bin/env").unwrap_or_else(|e| panic!("{e}"));
        assert!(system_owned(&env, None));
        // Not by a name that looks like it, nor any folder the system doesn't protect.
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let lookalike = dir.path().join("usr/bin/env");
        std::fs::create_dir_all(lookalike.parent().unwrap_or(Path::new("/")))
            .unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(&lookalike, "").unwrap_or_else(|e| panic!("{e}"));
        assert!(!system_owned(&lookalike, None));
        for elsewhere in [
            "/usr/local/bin/x",
            "/opt/x/bin/x",
            "/nix/store/x/bin/x",
            "/snap/bin/x",
        ] {
            assert!(!system_owned(Path::new(elsewhere), None), "{elsewhere}");
        }
        // Root's, but in a folder of the system's it doesn't protect: hashed like any other.
        let unprotected =
            std::fs::canonicalize("/usr/lib/os-release").unwrap_or_else(|e| panic!("{e}"));
        assert!(
            !system_owned(&unprotected, None),
            "{}",
            unprotected.display()
        );
    }
}
