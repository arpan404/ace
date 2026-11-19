//! The read-only sandbox a settled command runs in (ADR 0172, amendment 7), against real Linux
//! objects: a settled read can read the bot's folder and the system paths it needs to start, and
//! nothing else. A symlink or a recursive read pointing out of the folder is refused by the
//! kernel, not by a path check, and the command writes nowhere.
#![cfg(all(target_os = "linux", feature = "landlock"))]
mod linux;

use std::path::Path;
use std::process::{Command, Output};

use spade_sandbox::{Facts, Policy};

/// A read-only policy for the bot's folder: no consented folders, no toolchains, no network, like
/// the server builds for a settled command.
fn read_only_policy(world: &linux::World) -> Policy {
    Policy::build(&Facts {
        home: world.home.clone(),
        spade_data: world.home.join(".local/share/spade"),
        ace_data: None,
        workspace: world.workspace.clone(),
        folders: vec![],
        toolchains: vec![],
        also_read: vec![],
        scratch: vec![],
        proxy_port: None,
    })
}

/// Runs `program args` in the read-only sandbox, from the workspace.
fn run_read_only(world: &linux::World, program: &str, args: &[&str]) -> Output {
    let launch = linux::runner()
        .wrap_read_only(
            &read_only_policy(world),
            Path::new(program),
            &args.iter().map(Into::into).collect::<Vec<_>>(),
        )
        .unwrap_or_else(|e| panic!("the read-only sandbox could not start: {e}"));
    Command::new(&launch.program)
        .args(&launch.args)
        .current_dir(&world.workspace)
        .output()
        .unwrap_or_else(|e| panic!("{e}"))
}

/// Runs `script` through `/bin/sh -c` in the read-only sandbox, as a settled one-shot command
/// does, with the clean environment Spade gives one.
fn shell_read_only(world: &linux::World, script: &str) -> Output {
    let launch = linux::runner()
        .wrap_read_only(
            &read_only_policy(world),
            Path::new("/bin/sh"),
            &["-c".into(), script.into()],
        )
        .unwrap_or_else(|e| panic!("the read-only sandbox could not start: {e}"));
    Command::new(&launch.program)
        .args(&launch.args)
        .current_dir(&world.workspace)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", &world.workspace)
        .env("TMPDIR", "/nonexistent")
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap_or_else(|e| panic!("{e}"))
}

/// Every program the classifier may settle starts under the read-only profile (ADR 0172,
/// amendment 7): the narrow library allowlist is enough to load each one. A program that can't
/// start here would have to leave the settled set; this guards that none silently does.
#[test]
fn every_settled_program_starts_under_the_read_only_profile() {
    let w = linux::world();
    std::fs::write(w.workspace.join("f.txt"), "one\ntwo\n").unwrap_or_else(|e| panic!("{e}"));
    // A trivial read for each kept program (coreutils, diffutils, findutils, util-linux, jq, file,
    // and the hardened git/rg/grep), chosen so a clean start exits 0.
    let probes = [
        "cat f.txt",
        "head f.txt",
        "tail f.txt",
        "wc f.txt",
        "ls",
        "date",
        "basename /a/b",
        "dirname /a/b",
        "realpath f.txt",
        "readlink -f f.txt",
        "stat f.txt",
        "du -s .",
        "df .",
        "sort f.txt",
        "uniq f.txt",
        "cut -c1 f.txt",
        "tr a b <f.txt",
        "nl f.txt",
        "fold f.txt",
        "fmt f.txt",
        "expand f.txt",
        "unexpand f.txt",
        "tac f.txt",
        "od f.txt",
        "sha256sum f.txt",
        "sha1sum f.txt",
        "sha512sum f.txt",
        "md5sum f.txt",
        "cksum f.txt",
        "b2sum f.txt",
        "seq 3",
        "id",
        "whoami",
        "uname",
        "nproc",
        "printenv PATH",
        "base32 f.txt",
        "numfmt 1",
        "factor 12",
        "expr 1 + 1",
        "diff f.txt f.txt",
        "cmp f.txt f.txt",
        "which cat",
        "strings f.txt",
        "rev f.txt",
        "hexdump f.txt",
        "find . -maxdepth 1",
        "file f.txt",
        "grep one f.txt",
        "rg one f.txt",
        "git --version",
    ];
    let mut failed = Vec::new();
    for probe in probes {
        let program = probe.split_whitespace().next().unwrap_or("");
        if !linux::has(program) {
            continue;
        }
        let out = shell_read_only(&w, probe);
        let text = String::from_utf8_lossy(&out.stderr);
        // A start failure is the loader or exec refusing: that is what must not happen. A non-zero
        // exit with no such message (`cmp` on equal files, `whoami` that can't map the uid to a
        // name offline) is a runtime result, not a failure to start, and is fine.
        if text.contains("error while loading shared libraries")
            || text.contains("cannot execute")
            || text.contains("not found")
        {
            failed.push(format!("{probe}: {}", text.trim()));
        }
    }
    assert!(
        failed.is_empty(),
        "programs that didn't start cleanly:\n{}",
        failed.join("\n")
    );
}

#[test]
fn a_settled_cat_of_a_symlink_out_of_the_folder_reads_nothing() {
    let w = linux::world();
    // A secret outside the folder, and a symlink to it inside the folder.
    let secret = w.root.join("victim.txt");
    std::fs::write(&secret, "TOP-SECRET-abc123").unwrap_or_else(|e| panic!("{e}"));
    let link = w.workspace.join("README.md");
    std::os::unix::fs::symlink(&secret, &link).unwrap_or_else(|e| panic!("{e}"));
    let out = run_read_only(&w, "/usr/bin/cat", &["README.md"]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        !stdout.contains("TOP-SECRET"),
        "the secret leaked through the symlink: {stdout}"
    );
    assert!(!out.status.success(), "cat should have been denied");
    // A plain read inside the folder works, so the sandbox isn't just breaking everything.
    std::fs::write(w.workspace.join("inside.txt"), "ok-inside").unwrap_or_else(|e| panic!("{e}"));
    let ok = run_read_only(&w, "/usr/bin/cat", &["inside.txt"]);
    assert!(ok.status.success());
    assert_eq!(String::from_utf8_lossy(&ok.stdout).trim(), "ok-inside");
}

#[test]
fn a_recursive_read_through_a_symlinked_dir_out_of_the_folder_sees_nothing_outside() {
    let w = linux::world();
    // A secret file in a folder outside the workspace, and a symlinked directory to it inside.
    let outside = w.root.join("secrets");
    std::fs::create_dir_all(&outside).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(outside.join("key.txt"), "SECRET-KEY-xyz789").unwrap_or_else(|e| panic!("{e}"));
    std::os::unix::fs::symlink(&outside, w.workspace.join("vendor"))
        .unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(w.workspace.join("own.txt"), "SECRET-KEY-here-is-not").unwrap_or_default();
    for (program, args) in [
        ("/usr/bin/grep", vec!["-rn", "SECRET-KEY", "."]),
        ("/usr/bin/find", vec![".", "-name", "key.txt"]),
    ] {
        let out = run_read_only(&w, program, &args);
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            !stdout.contains("xyz789") && !stdout.contains("vendor/key.txt"),
            "{program} read through the symlinked dir: {stdout}"
        );
    }
}

#[test]
fn a_settled_command_cannot_read_credentials_or_write() {
    let w = linux::world();
    // The credential deny-list is closed even though it is under the home folder.
    std::os::unix::fs::symlink(w.home.join(".ssh/id_ed25519"), w.workspace.join("key"))
        .unwrap_or_else(|e| panic!("{e}"));
    let out = run_read_only(&w, "/usr/bin/cat", &["key"]);
    assert!(
        !String::from_utf8_lossy(&out.stdout).contains("private key"),
        "a settled read reached a credential"
    );
    // A write in the folder is refused: the sandbox is read-only.
    let wrote = run_read_only(&w, "/usr/bin/touch", &["new.txt"]);
    assert!(
        !wrote.status.success(),
        "a write succeeded in a read-only sandbox"
    );
    assert!(
        !w.workspace.join("new.txt").exists(),
        "a file was created read-only"
    );
}

#[test]
fn git_with_a_gitdir_file_pointing_out_of_the_folder_cannot_read_it() {
    let w = linux::world();
    // A git repository outside the folder, and a `.git` file inside pointing at it.
    let outside_repo = w.root.join("outside-repo/.git");
    std::fs::create_dir_all(&outside_repo).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(outside_repo.join("HEAD"), "ref: refs/heads/main\n").unwrap_or_default();
    std::fs::write(
        outside_repo.join("config"),
        "[core]\n\tfsmonitor = /root/evil\n",
    )
    .unwrap_or_default();
    std::fs::write(
        w.workspace.join(".git"),
        format!("gitdir: {}\n", outside_repo.display()),
    )
    .unwrap_or_default();
    // git reads the `.git` file, follows it outside, and is denied: it can't report HEAD.
    let out = run_read_only(&w, "/usr/bin/git", &["rev-parse", "HEAD"]);
    assert!(
        !out.status.success(),
        "git read the repository outside the folder: {}",
        String::from_utf8_lossy(&out.stdout)
    );
}

/// A read-only run is offline: the kernel refuses to create any socket, so nothing can reach the
/// network, bind a port, or open a Unix socket — not even one inside the workspace (ADR 0172,
/// amendment 7, finding 3). Uses python3 as a socket client; skipped where it isn't installed.
#[test]
fn a_read_only_run_can_make_no_socket_at_all() {
    let w = linux::world();
    if !linux::has("python3") {
        return;
    }
    // A real Unix socket listening inside the workspace, and a loopback TCP port: a sandboxed run
    // must reach neither, because it cannot create a socket in the first place.
    let sock = w.workspace.join("db.sock");
    let _listener = std::os::unix::net::UnixListener::bind(&sock).unwrap_or_else(|e| panic!("{e}"));
    for attempt in [
        "socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
        "socket.socket(socket.AF_INET6, socket.SOCK_STREAM)",
        "s=socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.bind(('127.0.0.1', 0))",
        "s=socket.socket(socket.AF_UNIX); s.connect('db.sock')",
    ] {
        // The marker prints only if the call returned, and is read from stdout alone: a Python
        // traceback echoes the source line (which names the marker) to stderr even on failure.
        let out = shell_read_only(
            &w,
            &format!("python3 -c 'import socket; {attempt}; print(chr(79)+\"K-reached\")'"),
        );
        let made = String::from_utf8_lossy(&out.stdout).contains("OK-reached");
        assert!(
            !made && !out.status.success(),
            "a read-only run reached the network via `{attempt}` code={:?}: {}{}",
            out.status.code(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
}

/// The read-only allowlist is narrow: a symlink in the folder to a readable file under a broad
/// system folder a normal run could read (`/opt`, `/etc`, `/var/lib`) is refused, because those
/// folders are not opened for a read-only run (ADR 0172, amendment 7, finding 2).
#[test]
fn a_symlink_to_a_broad_system_folder_is_denied_read_only() {
    let w = linux::world();
    for (i, system) in ["/opt", "/etc", "/var/lib", "/sys"].iter().enumerate() {
        // Find a readable regular file under the system folder to point at; skip if none exists.
        let Some(target) = first_readable_file(std::path::Path::new(system)) else {
            continue;
        };
        let link = w.workspace.join(format!("link{i}"));
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap_or_else(|e| panic!("{e}"));
        let out = run_read_only(&w, "/usr/bin/cat", &[link.to_str().unwrap_or("")]);
        assert!(
            !out.status.success(),
            "a read-only run read {target:?} under {system} through a symlink: {}",
            String::from_utf8_lossy(&out.stdout)
        );
    }
}

/// A read-only run gets only the null sink as a device: `/dev/zero`, `/dev/urandom` and `/dev/tty`
/// a normal run may open are closed (ADR 0172, amendment 7, finding 4's Linux counterpart).
#[test]
fn only_dev_null_is_open_to_a_read_only_run() {
    let w = linux::world();
    let null = run_read_only(&w, "/usr/bin/cat", &["/dev/null"]);
    assert!(
        null.status.success(),
        "a read-only run couldn't open /dev/null"
    );
    for closed in ["/dev/zero", "/dev/urandom", "/dev/full"] {
        // `head -c1` so a success wouldn't block on an endless device.
        let out = run_read_only(&w, "/usr/bin/head", &["-c1", closed]);
        assert!(
            !out.status.success(),
            "a read-only run opened {closed}: {}",
            String::from_utf8_lossy(&out.stdout)
        );
    }
}

/// The first readable regular file anywhere under `dir`, or `None`. Used to point a symlink at
/// real system data without hard-coding a path that may not exist on every machine.
fn first_readable_file(dir: &Path) -> Option<std::path::PathBuf> {
    let mut stack = vec![dir.to_path_buf()];
    let mut seen = 0;
    while let Some(d) = stack.pop() {
        seen += 1;
        if seen > 400 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() && meta.len() > 0 && std::fs::File::open(&path).is_ok() {
                return Some(path);
            }
        }
    }
    None
}
