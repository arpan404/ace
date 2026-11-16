//! Small real commands under the macOS sandbox (ADR 0167 decision 1): what a bot's run can and
//! can't read, write and reach. A fake home folder in a temporary folder stands in for the
//! person's, so nothing real is touched.
#![cfg(target_os = "macos")]

use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use spade_sandbox::{Facts, Policy, Runner};

struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    workspace: PathBuf,
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let root = std::fs::canonicalize(dir.path()).unwrap_or_else(|_| std::process::abort());
    let home = root.join("home");
    let data = home.join("Library/Spade");
    let workspace = data.join("workspace/bot1");
    for folder in [
        workspace.join(".spade/tmp"),
        data.join("workspace/bot2"),
        home.join(".ssh"),
        home.join(".cargo/bin"),
        home.join("Documents"),
        home.join("code/app"),
        home.join("notes"),
    ] {
        std::fs::create_dir_all(folder).unwrap_or_default();
    }
    for (file, text) in [
        (home.join(".ssh/id_ed25519"), "private key"),
        (home.join(".cargo/bin/tool"), "tool"),
        (home.join(".cargo/credentials.toml"), "token"),
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

fn policy(world: &World, proxy_port: Option<u16>) -> Policy {
    Policy::build(&Facts {
        home: world.home.clone(),
        spade_data: world.home.join("Library/Spade"),
        ace_data: None,
        workspace: world.workspace.clone(),
        folders: vec![
            (world.home.join("code/app"), true),
            (world.home.join("notes"), false),
        ],
        toolchains: vec![world.home.join(".cargo")],
        also_read: vec![],
        proxy_port,
    })
}

/// Runs `script` with `sh -c` under `policy`: its exit code and what it printed.
fn run(policy: &Policy, script: &str) -> (i32, String) {
    let runner = Runner::probe(None);
    assert!(
        runner.status().contains(),
        "the sandbox should hold on this Mac: {:?}",
        runner.status()
    );
    let launch = runner
        .wrap(
            policy,
            Path::new("/bin/sh"),
            &[OsString::from("-c"), OsString::from(script)],
        )
        .unwrap_or_else(|error| panic!("{error}"));
    let out = Command::new(&launch.program)
        .args(&launch.args)
        .current_dir(&policy.workspace)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &policy.workspace)
        .env("TMPDIR", &policy.temp)
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

fn ok(policy: &Policy, script: &str) -> String {
    let (code, text) = run(policy, script);
    assert_eq!(code, 0, "`{script}` should run: {text}");
    text
}

fn refused(policy: &Policy, script: &str) {
    let (code, text) = run(policy, script);
    assert_ne!(code, 0, "`{script}` should be refused: {text}");
}

fn quoted(path: &Path) -> String {
    format!("'{}'", path.display())
}

#[test]
fn a_run_writes_in_its_workspace_and_granted_folders_and_nowhere_else() {
    let world = world();
    let policy = policy(&world, None);
    let text = ok(
        &policy,
        "echo built > out.txt && mkdir -p target/debug && cat out.txt && echo t > \"$TMPDIR/x\"",
    );
    assert!(text.contains("built"));
    ok(
        &policy,
        &format!("echo patch > {}", quoted(&world.home.join("code/app/a.rs"))),
    );
    for outside in [
        world.root.join("outside.txt"),
        world.home.join("notes/todo.md"),
        world.home.join("Documents/new.txt"),
        world.home.join(".cargo/bin/tool"),
        world.home.join("Library/Spade/workspace/bot2/planted.txt"),
    ] {
        refused(&policy, &format!("echo x > {}", quoted(&outside)));
    }
    assert!(!world.root.join("outside.txt").exists());
}

#[test]
fn credentials_the_persons_files_spades_data_and_other_bots_are_unreadable() {
    let world = world();
    let policy = policy(&world, None);
    for hidden in [
        world.home.join(".ssh/id_ed25519"),
        world.home.join(".cargo/credentials.toml"),
        world.home.join("Documents/tax.pdf"),
        world.home.join("Library/Spade/spade.db"),
        world.home.join("Library/Spade/workspace/bot2/secret.txt"),
    ] {
        refused(&policy, &format!("cat {}", quoted(&hidden)));
    }
    refused(&policy, &format!("ls {}", quoted(&world.home)));
}

#[test]
fn toolchains_and_folders_granted_for_reading_are_readable() {
    let world = world();
    let policy = policy(&world, None);
    let text = ok(
        &policy,
        &format!(
            "cat {} {} && cd {} && pwd",
            quoted(&world.home.join(".cargo/bin/tool")),
            quoted(&world.home.join("notes/todo.md")),
            quoted(&world.home.join("code/app")),
        ),
    );
    assert!(text.contains("tool") && text.contains("todo") && text.contains("code/app"));
}

#[test]
fn a_hard_link_to_a_file_outside_cannot_be_made_and_a_symlink_cannot_be_written_through() {
    let world = world();
    let policy = policy(&world, None);
    let victim = world.root.join("victim.txt");
    refused(
        &policy,
        &format!("ln {} hard && echo pwn >> hard", quoted(&victim)),
    );
    refused(
        &policy,
        &format!("ln -s {} soft; echo pwn >> soft", quoted(&victim)),
    );
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap_or_default(),
        "victim"
    );
    ok(&policy, "echo a > a && ln -s a b && ln a c && cat b c");
}

/// A listener that answers each connection with `ok`, outside the sandbox.
fn listener() -> u16 {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|_| std::process::abort());
    let port = socket.local_addr().map(|a| a.port()).unwrap_or(0);
    std::thread::spawn(move || {
        for mut stream in socket.incoming().flatten() {
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer);
            let _ = stream.write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok");
        }
    });
    port
}

#[test]
fn a_run_reaches_only_the_proxys_port_and_no_names() {
    let world = world();
    let (proxy, other) = (listener(), listener());
    let policy = policy(&world, Some(proxy));
    let text = ok(&policy, &format!("curl -sS -m 5 http://127.0.0.1:{proxy}/"));
    assert_eq!(text, "ok");
    refused(&policy, &format!("curl -sS -m 5 http://127.0.0.1:{other}/"));
    // No DNS: a name can't be looked up, so it can't carry data out either.
    refused(&policy, "curl -sS -m 5 https://example.com/");
    let offline = self::policy(&world, None);
    refused(
        &offline,
        &format!("curl -sS -m 5 http://127.0.0.1:{proxy}/"),
    );
}

#[test]
fn a_run_can_listen_on_loopback_for_a_dev_server() {
    let world = world();
    let policy = policy(&world, None);
    ok(
        &policy,
        "python3 -c 'import socket; s=socket.socket(); s.bind((\"127.0.0.1\", 0)); s.listen(1); print(s.getsockname()[1])'",
    );
}

#[test]
fn a_run_cannot_start_or_drive_other_apps() {
    let world = world();
    let policy = policy(&world, None);
    refused(&policy, "open -a Calculator");
    refused(
        &policy,
        "osascript -e 'tell application \"Finder\" to get the name of every disk'",
    );
}
