//! Resolving the read paths a settled command needs before it is confined (ADR 0172, amendment 7).
//!
//! A read-only sandbox opens a narrow allowlist of system folders (`spade-sandbox`); a settled
//! command's own programs may live outside it — Homebrew's `/opt/homebrew`, a Cargo `~/.cargo/bin`,
//! or, on macOS, the developer tools behind the `/usr/bin/git` xcrun shim. Spade resolves each
//! program on the clean PATH here, outside the sandbox, and hands the sandbox exactly the extra read
//! roots they need. A program that can't be resolved means the command does not settle (it goes to
//! the reviewer) rather than failing with "command not found" inside the sandbox.

use std::path::{Path, PathBuf};

use spade_core::autonomy::shell;

/// What a settled command needs beyond the read-only base allowlist.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Reads {
    /// Extra read-only roots to open (a resolved program's install prefix; on macOS the active
    /// developer dir).
    pub reads: Vec<PathBuf>,
    /// Folders to put before the system ones on the command's `PATH`, so the shell finds a program
    /// that isn't in a system folder (Homebrew, Cargo).
    pub path_first: Vec<PathBuf>,
}

/// Shell words that name a builtin, not an external program to resolve.
fn builtin(name: &str) -> bool {
    matches!(
        name,
        "echo"
            | "printf"
            | "true"
            | "false"
            | "test"
            | "["
            | "pwd"
            | "type"
            | "cd"
            | "pushd"
            | "popd"
            | "exit"
            | "return"
            | "shift"
            | "wait"
    )
}

/// System folders already in the read-only base allowlist: a program found here needs no extra read
/// root.
const SYSTEM_BIN: &[&str] = &["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/// Settled programs that, on macOS, are xcrun shims under `/usr/bin`: they are "found" in a system
/// folder but can run only once the active developer dir is readable.
#[cfg(target_os = "macos")]
const MACOS_DEVELOPER_TOOLS: &[&str] = &["git", "strings"];

/// The extra folders a program may live in, outside the base allowlist: Homebrew and Cargo. A
/// program found here is allowed by adding its install prefix read-only (it is one of the settled
/// read programs, which run no configuration that can execute, under a read-only offline sandbox).
fn extra_bin_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/usr/local/bin")];
    #[cfg(target_os = "macos")]
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    #[cfg(not(target_os = "macos"))]
    dirs.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
    dirs.push(home.join(".cargo/bin"));
    dirs
}

/// The read roots a program resolved outside the base allowlist needs: its own folder and, from the
/// prefix above it, the `lib`, `libexec` and `share` folders that exist. Follows the binary through
/// symlinks (Homebrew points `/opt/homebrew/bin` into `Cellar`) and covers the real location too.
fn prefix_reads(bin_dir: &Path, binary: &Path) -> Vec<PathBuf> {
    let mut out = vec![bin_dir.to_path_buf()];
    let add_prefix = |out: &mut Vec<PathBuf>, dir: &Path| {
        if let Some(root) = dir.parent() {
            for sub in ["lib", "libexec", "share"] {
                let p = root.join(sub);
                if p.exists() {
                    out.push(p);
                }
            }
        }
    };
    add_prefix(&mut out, bin_dir);
    if let Ok(real) = std::fs::canonicalize(binary)
        && let Some(real_dir) = real.parent()
    {
        out.push(real_dir.to_path_buf());
        add_prefix(&mut out, real_dir);
    }
    out
}

/// macOS's active developer dir (`xcode-select -p`), where the real `git` and other tools live, or
/// `None` when no developer tools are installed.
#[cfg(target_os = "macos")]
fn developer_dir() -> Option<PathBuf> {
    let out = std::process::Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8(out.stdout).ok()?.trim());
    path.is_dir().then_some(path)
}

/// The extra reads and PATH folders `command`'s programs need, or `None` when a program can't be
/// resolved on the clean PATH (so the command must not settle). The command has already been found
/// settleable, so it parses and runs only the audited read programs.
pub fn resolve(command: &str, home: &Path) -> Option<Reads> {
    let simples = shell::read(command)?;
    let system: Vec<PathBuf> = SYSTEM_BIN.iter().map(PathBuf::from).collect();
    let extra = extra_bin_dirs(home);
    let mut reads = Reads::default();
    #[cfg(target_os = "macos")]
    let mut needs_developer = false;
    for simple in &simples {
        let Some(first) = simple.words.first() else {
            continue;
        };
        let program = first.rsplit('/').next().unwrap_or(first);
        if builtin(program) {
            continue;
        }
        // A program given by an explicit path isn't a resolved name from the clean PATH; the
        // settled set is bare names, so treat it as not settleable.
        if first.contains('/') {
            return None;
        }
        #[cfg(target_os = "macos")]
        if MACOS_DEVELOPER_TOOLS.contains(&program) {
            needs_developer = true;
        }
        if system.iter().any(|dir| dir.join(program).exists()) {
            continue;
        }
        let found = extra.iter().find_map(|dir| {
            let binary = dir.join(program);
            binary
                .exists()
                .then(|| (dir.clone(), prefix_reads(dir, &binary)))
        });
        match found {
            Some((bin_dir, prefix)) => {
                reads.path_first.push(bin_dir);
                reads.reads.extend(prefix);
            }
            None => return None,
        }
    }
    #[cfg(target_os = "macos")]
    match developer_dir() {
        Some(dev) => {
            for sub in ["usr/bin", "usr/lib", "usr/libexec", "usr/share"] {
                let p = dev.join(sub);
                if p.exists() {
                    reads.reads.push(p);
                }
            }
        }
        // A command that runs a developer-tools shim can't settle without the developer dir.
        None if needs_developer => return None,
        None => {}
    }
    dedup(&mut reads.reads);
    dedup(&mut reads.path_first);
    Some(reads)
}

fn dedup(paths: &mut Vec<PathBuf>) {
    paths.sort();
    paths.dedup();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_system_program_needs_no_extra_reads() {
        // `cat` and `wc` are in a system folder on every supported platform.
        let reads =
            resolve("cat f | wc -l", Path::new("/home/p")).unwrap_or_else(|| panic!("none"));
        // No Homebrew/Cargo prefix was added for system programs (the developer dir on macOS aside).
        assert!(
            reads
                .reads
                .iter()
                .all(|p| !p.starts_with("/opt/homebrew") && !p.starts_with("/home/p/.cargo")),
            "{reads:?}"
        );
        assert!(reads.path_first.is_empty(), "{reads:?}");
    }

    #[test]
    fn builtins_are_not_resolved() {
        // `cd` and `pwd` have no binary in some layouts; they must not force an abstain.
        assert!(resolve("cd sub && pwd", Path::new("/home/p")).is_some());
    }

    #[test]
    fn a_program_given_by_path_does_not_settle() {
        assert!(resolve("/tmp/evil arg", Path::new("/home/p")).is_none());
    }

    #[test]
    fn an_unresolvable_program_does_not_settle() {
        // A name that is in no system or extra folder (chosen not to exist on a CI machine).
        assert!(resolve("spade-nonesuch-xyzzy --version", Path::new("/home/p")).is_none());
    }
}

/// The read-only Seatbelt sandbox against real macOS objects (ADR 0172, amendment 7). Run on a Mac
/// (`cargo test -p spade-server --target <mac>`); it is skipped on a Mac without `sandbox-exec`.
/// Builds the launch exactly as `confine::read_only` does: the resolved program reads in
/// `also_read`, `/bin/sh -c`, a clean environment. Containment must hold and the settled programs,
/// including the `/usr/bin/git` xcrun shim, must still run.
#[cfg(all(test, target_os = "macos"))]
mod macos {
    use std::path::Path;
    use std::process::Command;

    use spade_sandbox::{Facts, Policy, Runner};

    use super::resolve;

    struct World {
        _dir: tempfile::TempDir,
        root: std::path::PathBuf,
        home: std::path::PathBuf,
        workspace: std::path::PathBuf,
    }

    fn world() -> World {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let root = std::fs::canonicalize(dir.path()).unwrap_or_else(|e| panic!("{e}"));
        let home = root.join("home");
        let workspace = home.join(".local/share/spade/workspace/bot1");
        std::fs::create_dir_all(&workspace).unwrap_or_else(|e| panic!("{e}"));
        World {
            _dir: dir,
            root,
            home,
            workspace,
        }
    }

    fn runner() -> Option<Runner> {
        let runner = Runner::probe(None);
        runner.status().contains().then_some(runner)
    }

    /// Runs `script` through `/bin/sh -c` in the read-only sandbox, with the reads `resolve` found
    /// for it, as a settled one-shot command does. `None` when the command wouldn't settle.
    fn run(runner: &Runner, w: &World, script: &str) -> Option<std::process::Output> {
        let reads = resolve(script, &w.home)?;
        let policy = Policy::build(&Facts {
            home: w.home.clone(),
            spade_data: w.home.join(".local/share/spade"),
            workspace: w.workspace.clone(),
            also_read: reads.reads,
            ..Default::default()
        });
        let launch = runner
            .wrap_read_only(&policy, Path::new("/bin/sh"), &["-c".into(), script.into()])
            .unwrap_or_else(|e| panic!("the read-only sandbox could not start: {e}"));
        let path_first: Vec<String> = reads
            .path_first
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let path = path_first
            .iter()
            .map(String::as_str)
            .chain(["/usr/bin", "/bin"])
            .collect::<Vec<_>>()
            .join(":");
        Some(
            Command::new(&launch.program)
                .args(&launch.args)
                .current_dir(&w.workspace)
                .env_clear()
                .env("PATH", path)
                .env("HOME", &w.workspace)
                .env("TMPDIR", "/nonexistent")
                .stdin(std::process::Stdio::null())
                .output()
                .unwrap_or_else(|e| panic!("{e}")),
        )
    }

    fn text(out: &std::process::Output) -> String {
        format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
    }

    #[test]
    fn containment_holds_and_the_settled_programs_still_run() {
        let Some(runner) = runner() else {
            eprintln!("no macOS sandbox here; skipping");
            return;
        };
        let w = world();

        // A secret outside the folder, reached through a symlink inside it: refused, nothing leaks.
        std::fs::write(w.root.join("victim.txt"), "TOP-SECRET-abc")
            .unwrap_or_else(|e| panic!("{e}"));
        std::os::unix::fs::symlink(w.root.join("victim.txt"), w.workspace.join("link"))
            .unwrap_or_else(|e| panic!("{e}"));
        let out = run(&runner, &w, "cat link").unwrap_or_else(|| panic!("should settle"));
        assert!(!text(&out).contains("TOP-SECRET"), "{}", text(&out));
        assert!(!out.status.success());

        // /etc/hosts and a /Library prefs tree, directly and through a symlink: refused.
        for target in ["/etc/hosts", "/Library/Preferences"] {
            let out =
                run(&runner, &w, &format!("cat {target}")).unwrap_or_else(|| panic!("settle"));
            assert!(!out.status.success(), "{target} was read: {}", text(&out));
        }

        // A recursive read through a symlinked directory out of the folder sees nothing outside.
        std::fs::create_dir_all(w.root.join("secrets")).unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(w.root.join("secrets/key.txt"), "SECRET-xyz")
            .unwrap_or_else(|e| panic!("{e}"));
        std::os::unix::fs::symlink(w.root.join("secrets"), w.workspace.join("vendor"))
            .unwrap_or_else(|e| panic!("{e}"));
        let out = run(&runner, &w, "grep -r SECRET-xyz .").unwrap_or_else(|| panic!("settle"));
        assert!(!text(&out).contains("SECRET-xyz"), "{}", text(&out));

        // A write is refused; /dev/null is open; /dev/tty is not; loopback is unreachable; /Users
        // and `ps`/`open` outside the sandbox are refused.
        assert!(!run(&runner, &w, "touch new.txt").unwrap().status.success());
        assert!(!w.workspace.join("new.txt").exists());
        assert!(run(&runner, &w, "cat /dev/null").unwrap().status.success());
        assert!(!run(&runner, &w, "cat /dev/tty").unwrap().status.success());
        assert!(
            !run(&runner, &w, "exec 3<>/dev/tcp/127.0.0.1/22")
                .unwrap()
                .status
                .success()
        );
        assert!(!run(&runner, &w, "ls /Users").unwrap().status.success());

        // The fix: the `/usr/bin/git` xcrun shim resolves the developer dir and runs.
        let version =
            run(&runner, &w, "git --version").unwrap_or_else(|| panic!("git should settle"));
        assert!(
            version.status.success() && text(&version).contains("git version"),
            "git --version failed under read-only: {}",
            text(&version)
        );

        // And a real read in a repository inside the folder succeeds. The repo is built outside the
        // sandbox; only the `git log` read runs under it.
        let git = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&w.workspace)
                .status()
                .unwrap_or_else(|e| panic!("{e}"));
        };
        git(&["init", "-q"]);
        std::fs::write(w.workspace.join("f.txt"), "hello\n").unwrap_or_else(|e| panic!("{e}"));
        git(&["add", "-A"]);
        git(&[
            "-c",
            "user.email=a@b.c",
            "-c",
            "user.name=t",
            "commit",
            "-qam",
            "x",
        ]);
        let log = run(&runner, &w, "git log -1 --oneline").unwrap_or_else(|| panic!("git settle"));
        assert!(
            log.status.success(),
            "git log -1 failed under read-only: {}",
            text(&log)
        );
    }
}
