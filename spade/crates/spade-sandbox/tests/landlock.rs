//! Files under Linux's sandbox (ADR 0167 decision 1), with real commands: what a bot's run can
//! and can't read and write, links included.
#![cfg(all(target_os = "linux", feature = "landlock"))]

mod linux;

use linux::{ok, policy, quoted, refused, run, world};

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
        world
            .home
            .join(".local/share/spade/workspace/bot2/planted.txt"),
        "/tmp/spade-sandbox-escape.txt".into(),
        "/etc/spade-sandbox-escape.txt".into(),
    ] {
        refused(&policy, &format!("echo x > {}", quoted(&outside)));
    }
    assert!(!world.root.join("outside.txt").exists());
    // `truncate` by path is held too (Landlock ABI 3, or the filter below it).
    refused(
        &policy,
        &format!(
            "truncate -s 0 {}",
            quoted(&world.home.join("notes/todo.md"))
        ),
    );
    assert_eq!(
        std::fs::read_to_string(world.home.join("notes/todo.md")).unwrap_or_default(),
        "todo"
    );
}

#[test]
fn credentials_the_persons_files_spades_data_and_other_bots_are_unreadable() {
    let world = world();
    let policy = policy(&world, None);
    for hidden in [
        world.home.join(".ssh/id_ed25519"),
        world.home.join(".aws/credentials"),
        world.home.join(".netrc"),
        // Inside a toolchain the person granted for reading.
        world.home.join(".cargo/credentials.toml"),
        world.home.join("Documents/tax.pdf"),
        world.home.join(".local/share/spade/spade.db"),
        world
            .home
            .join(".local/share/spade/workspace/bot2/secret.txt"),
    ] {
        refused(&policy, &format!("cat {}", quoted(&hidden)));
    }
    refused(&policy, &format!("ls {}", quoted(&world.home)));
    refused(&policy, &format!("ls {}", quoted(&world.home.join(".ssh"))));
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
fn a_hard_link_to_a_file_outside_cannot_be_made_and_a_symlink_cannot_be_followed_out() {
    let world = world();
    let policy = policy(&world, None);
    let victim = world.root.join("victim.txt");
    let key = world.home.join(".ssh/id_ed25519");
    refused(
        &policy,
        &format!("ln {} hard && echo pwn >> hard", quoted(&victim)),
    );
    refused(&policy, &format!("ln {} key && cat key", quoted(&key)));
    refused(
        &policy,
        &format!("ln -s {} soft; echo pwn >> soft", quoted(&victim)),
    );
    refused(&policy, &format!("ln -s {} k; cat k", quoted(&key)));
    refused(
        &policy,
        &format!(
            "ln -s {} ssh; cat ssh/id_ed25519",
            quoted(&world.home.join(".ssh"))
        ),
    );
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap_or_default(),
        "victim"
    );
    // Links inside the workspace work.
    let text = ok(&policy, "echo a > a && ln -s a b && ln a c && cat b c");
    assert_eq!(text, "a\na\n");
}

#[test]
fn a_link_planted_in_a_granted_folder_does_not_open_what_it_points_to() {
    let world = world();
    // Made before the run, outside the sandbox: a readable toolchain pointing at the keys, and a
    // hard link to them inside it.
    let cargo = world.home.join(".cargo");
    let _ = std::os::unix::fs::symlink(world.home.join(".ssh"), cargo.join("alias"));
    let _ = std::fs::hard_link(world.home.join(".ssh/id_ed25519"), cargo.join("copy"));
    let policy = policy(&world, None);
    refused(
        &policy,
        &format!("cat {}", quoted(&cargo.join("alias/id_ed25519"))),
    );
    refused(&policy, &format!("cat {}", quoted(&cargo.join("copy"))));
    ok(&policy, &format!("cat {}", quoted(&cargo.join("bin/tool"))));
}

#[test]
fn only_system_folders_are_readable_outside_what_the_policy_opens() {
    let world = world();
    let policy = policy(&world, None);
    refused(
        &policy,
        &format!("cat {}", quoted(&world.root.join("victim.txt"))),
    );
    for place in ["/tmp", "/home", "/root", "/run", "/mnt", "/var/tmp"] {
        refused(&policy, &format!("ls {place}"));
    }
    let text = ok(
        &policy,
        "ls /usr/bin >/dev/null && python3 -c 'print(6*7)' && date >/dev/null && echo fine",
    );
    assert!(text.contains("42") && text.contains("fine"), "{text}");
}

#[test]
fn a_plugins_own_folder_inside_aces_data_is_readable_and_the_rest_of_aces_data_is_not() {
    let world = world();
    let plugin = world.home.join(".ace/plugins/p1");
    std::fs::create_dir_all(&plugin).unwrap_or_default();
    std::fs::write(plugin.join("server.js"), "plugin").unwrap_or_default();
    std::fs::write(world.home.join(".ace/grant.json"), "ace token").unwrap_or_default();
    let policy = spade_sandbox::Policy::build(&spade_sandbox::Facts {
        home: world.home.clone(),
        spade_data: world.home.join(".local/share/spade"),
        workspace: world.workspace.clone(),
        also_read: vec![plugin.clone()],
        ..spade_sandbox::Facts::default()
    });
    assert_eq!(
        ok(
            &policy,
            &format!("cat {}", quoted(&plugin.join("server.js")))
        ),
        "plugin"
    );
    refused(
        &policy,
        &format!("echo x > {}", quoted(&plugin.join("server.js"))),
    );
    refused(
        &policy,
        &format!("cat {}", quoted(&world.home.join(".ace/grant.json"))),
    );
}

#[test]
fn a_runs_exit_code_and_ending_signal_come_through_the_launcher() {
    let world = world();
    let policy = policy(&world, None);
    assert_eq!(run(&policy, "exit 7").0, 7);
    let out = linux::output(&policy, "kill -TERM $$");
    assert_eq!(
        std::os::unix::process::ExitStatusExt::signal(&out.status),
        Some(15)
    );
}

#[test]
fn limits_on_open_files_and_tasks_are_set() {
    let world = world();
    let policy = policy(&world, None);
    let text = ok(
        &policy,
        "grep -E 'Max (open files|processes)' /proc/self/limits",
    );
    // `Max processes  <soft>  <hard>  processes`: both bounded.
    for line in text.lines() {
        let numbers: Vec<u64> = line
            .split_whitespace()
            .filter_map(|word| word.parse().ok())
            .collect();
        assert_eq!(numbers.len(), 2, "{line} unlimited");
        if line.contains("open files") {
            assert!(numbers.iter().all(|n| *n <= 65_536), "{line}");
        }
    }
    assert_eq!(text.lines().count(), 2, "{text}");
}

#[test]
fn without_landlock_nothing_is_contained_and_the_status_says_why() {
    // Only a kernel without Landlock can show this (Docker Desktop's is one); elsewhere the
    // tests above show the opposite.
    if spade_sandbox::linux::landlock_supported() {
        return;
    }
    let runner = spade_sandbox::Runner::probe(Some(linux::launcher()));
    let status = runner.status();
    assert!(!status.contains() && !status.usable(), "{status:?}");
    assert_eq!(status.landlock_abi, None);
    assert!(
        status
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("doesn't enforce Landlock")),
        "{status:?}"
    );
}
