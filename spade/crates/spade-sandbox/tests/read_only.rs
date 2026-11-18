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
