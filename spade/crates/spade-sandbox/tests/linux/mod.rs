//! A fake home folder and small real commands run through Linux's launcher (ADR 0167 decision
//! 1), shared by the Linux sandbox tests. Nothing real is touched.
// Each test file uses part of it.
#![allow(dead_code)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use spade_sandbox::{Facts, Policy, Runner};

pub struct World {
    _dir: tempfile::TempDir,
    pub root: PathBuf,
    pub home: PathBuf,
    pub workspace: PathBuf,
}

pub fn world() -> World {
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let root = std::fs::canonicalize(dir.path()).unwrap_or_else(|_| std::process::abort());
    let home = root.join("home");
    let data = home.join(".local/share/spade");
    let workspace = data.join("workspace/bot1");
    for folder in [
        workspace.join(".spade/tmp"),
        data.join("workspace/bot2"),
        home.join(".ssh"),
        home.join(".aws"),
        home.join(".cargo/bin"),
        home.join("Documents"),
        home.join("code/app"),
        home.join("notes"),
    ] {
        std::fs::create_dir_all(folder).unwrap_or_default();
    }
    for (file, text) in [
        (home.join(".ssh/id_ed25519"), "private key"),
        (home.join(".aws/credentials"), "aws key"),
        (home.join(".cargo/bin/tool"), "tool"),
        (home.join(".cargo/credentials.toml"), "token"),
        (home.join(".netrc"), "machine x password y"),
        (home.join("Documents/tax.pdf"), "private"),
        (home.join("notes/todo.md"), "todo"),
        (data.join("spade.db"), "database"),
        (data.join("workspace/bot2/secret.txt"), "other bot"),
        (root.join("victim.txt"), "victim"),
    ] {
        std::fs::write(file, text).unwrap_or_default();
    }
    World {
        _dir: dir,
        root,
        home,
        workspace,
    }
}

pub fn policy(world: &World, proxy_port: Option<u16>) -> Policy {
    Policy::build(&Facts {
        home: world.home.clone(),
        spade_data: world.home.join(".local/share/spade"),
        ace_data: None,
        workspace: world.workspace.clone(),
        folders: vec![
            (world.home.join("code/app"), true),
            (world.home.join("notes"), false),
        ],
        toolchains: vec![world.home.join(".cargo")],
        also_read: vec![],
        scratch: vec![],
        proxy_port,
    })
}

pub fn launcher() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_spade-sandbox-launcher"))
}

/// The machine's sandbox, which must hold here.
pub fn runner() -> Runner {
    let runner = Runner::probe(Some(launcher()));
    assert!(
        runner.status().contains(),
        "the sandbox should hold on this machine: {:?}",
        runner.status()
    );
    runner
}

/// Whether commands run in their own PID namespace (an init, a fresh `/proc`) on this machine.
pub fn namespaced() -> bool {
    runner().status().processes == spade_sandbox::Coverage::Contained
}

/// `program args` started by the launcher directly with `plan`, as `wrap` would with the status
/// that leads to it.
pub fn launched(plan: &spade_sandbox::linux::Plan, program: &str, args: &[&str]) -> Command {
    let mut command = Command::new(launcher());
    command
        .arg(spade_sandbox::linux::LAUNCHER_ARG)
        .arg(serde_json::to_string(plan).unwrap_or_else(|e| panic!("{e}")))
        .arg(program)
        .args(args)
        .current_dir(&plan.sockets)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", &plan.sockets)
        .stdin(Stdio::null());
    command
}

/// Runs `script` with `sh -c` under `policy`.
pub fn output(policy: &Policy, script: &str) -> Output {
    let launch = runner()
        .wrap(
            policy,
            Path::new("/bin/sh"),
            &[OsString::from("-c"), OsString::from(script)],
        )
        .unwrap_or_else(|error| panic!("{error}"));
    Command::new(&launch.program)
        .args(&launch.args)
        .current_dir(&policy.workspace)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", &policy.workspace)
        .env("TMPDIR", &policy.temp)
        .stdin(Stdio::null())
        .output()
        .unwrap_or_else(|error| panic!("{error}"))
}

/// Its exit code and what it printed.
pub fn run(policy: &Policy, script: &str) -> (i32, String) {
    let out = output(policy, script);
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (out.status.code().unwrap_or(-1), text)
}

pub fn ok(policy: &Policy, script: &str) -> String {
    let (code, text) = run(policy, script);
    assert_eq!(code, 0, "`{script}` should run: {text}");
    text
}

pub fn refused(policy: &Policy, script: &str) -> String {
    let (code, text) = run(policy, script);
    assert_ne!(code, 0, "`{script}` should be refused: {text}");
    text
}

/// The same script outside any sandbox: what a test compares against.
pub fn unconfined(dir: &Path, script: &str) -> (i32, String) {
    let out = Command::new("/bin/sh")
        .args(["-c", script])
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .unwrap_or_else(|error| panic!("{error}"));
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (out.status.code().unwrap_or(-1), text)
}

pub fn quoted(path: &Path) -> String {
    format!("'{}'", path.display())
}

/// Whether `program` is installed (tests that need it say so and pass when it isn't).
pub fn has(program: &str) -> bool {
    ["/usr/bin", "/bin", "/usr/local/bin"]
        .iter()
        .any(|dir| Path::new(dir).join(program).exists())
}
