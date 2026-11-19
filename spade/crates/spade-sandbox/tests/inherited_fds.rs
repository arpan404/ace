//! What an offline or read-only run inherits besides its stdio (ADR 0171, amendment 4), in the
//! real Linux sandbox and launcher: a descriptor the starting process left open without
//! close-on-exec (as a socket to anywhere could be) doesn't reach the command. A normal run, which
//! nothing seals, still gets it, so the check sees one when there is one.
#![cfg(all(target_os = "linux", feature = "landlock"))]
mod linux;

use std::ffi::OsString;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::process::{Command, Stdio};

use nix::fcntl::{FcntlArg, FdFlag, fcntl};
use spade_sandbox::{Facts, Launch, Policy};

/// Whether descriptor `fd` is open in the command, asked by the command itself.
fn script(fd: i32) -> String {
    format!("if (: <&{fd}) 2>/dev/null; then echo open; else echo closed; fi")
}

/// What `launch` prints, started by this process, which holds `fd` open across exec.
fn seen(launch: &Launch, workspace: &Path) -> String {
    let out = Command::new(&launch.program)
        .args(&launch.args)
        .current_dir(workspace)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", workspace)
        .stdin(Stdio::null())
        .output()
        .unwrap_or_else(|error| panic!("{error}"));
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

#[test]
fn a_descriptor_left_open_in_the_parent_never_reaches_an_offline_or_read_only_run() {
    let world = linux::world();
    let runner = linux::runner();
    assert!(runner.holds_offline());
    // Opened by this process and left open across exec, as a library might leave a socket.
    let leaked = std::fs::File::open("/dev/null").unwrap_or_else(|e| panic!("{e}"));
    let fd = leaked.as_raw_fd();
    fcntl(fd, FcntlArg::F_SETFD(FdFlag::empty())).unwrap_or_else(|e| panic!("{e}"));
    let args = [OsString::from("-c"), OsString::from(script(fd))];
    let sh = Path::new("/bin/sh");

    let normal = linux::policy(&world, None);
    let plain = runner
        .wrap(&normal, sh, &args)
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        seen(&plain, &world.workspace).trim(),
        "open",
        "a normal run inherits it"
    );

    let offline = runner
        .wrap_offline(&normal, sh, &args)
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(seen(&offline, &world.workspace).trim(), "closed");

    let read_only = Policy::build(&Facts {
        home: world.home.clone(),
        spade_data: world.home.join(".local/share/spade"),
        ace_data: None,
        workspace: world.workspace.clone(),
        folders: vec![],
        toolchains: vec![],
        also_read: vec![],
        scratch: vec![],
        proxy_port: None,
    });
    let read = runner
        .wrap_read_only(&read_only, sh, &args)
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(seen(&read, &world.workspace).trim(), "closed");
    drop(leaked);
}
