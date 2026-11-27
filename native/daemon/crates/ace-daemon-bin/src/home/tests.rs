// SPDX-License-Identifier: Apache-2.0
//! The home's TypeScript cases: `home-fresh-start.process.test.ts` and
//! `local-files.test.ts`.

use super::*;
use crate::test_support::TempDir;

/// `planHome`: one table of facts to plans.
#[test]
fn a_homes_facts_decide_its_plan() {
    assert_eq!(plan(Facts::Missing, 1), Plan::Create);
    assert_eq!(plan(Facts::Empty, 1), Plan::Adopt);
    assert_eq!(plan(Facts::Versioned(1), 1), Plan::Reuse);
    assert_eq!(
        plan(Facts::Versioned(2), 1),
        Plan::RefuseNewer { stored: 2 }
    );
    assert_eq!(plan(Facts::Versioned(0), 1), Plan::BackUp { from: 0 });
    assert_eq!(plan(Facts::Unversioned, 1), Plan::BackUp { from: 0 });
}

/// `markerVersion`: a marker ace can read, and everything else.
#[test]
fn only_a_marker_ace_can_read_names_a_version() {
    assert_eq!(
        marker_version("{\"format\":\"ace-v1\",\"createdAt\":\"2026-11-26T00:00:00.000Z\"}"),
        Some(1)
    );
    assert_eq!(
        marker_version("{\"format\":\"ace-v12\",\"createdAt\":\"x\"}"),
        Some(12)
    );
    assert_eq!(
        marker_version("{\"format\":\"ace-v01\",\"createdAt\":\"x\"}"),
        None
    );
    assert_eq!(marker_version("{\"createdAt\":\"x\"}"), None);
    assert_eq!(marker_version("not json"), None);
}

/// `renderMarker`: the exact bytes, with an ISO time.
#[test]
fn the_marker_is_the_json_the_typescript_writes() {
    assert_eq!(
        render_marker(1, 0),
        "{\"format\":\"ace-v1\",\"createdAt\":\"1970-01-01T00:00:00.000Z\"}\n"
    );
    assert_eq!(iso8601(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
    assert_eq!(iso8601(951_782_400_000), "2000-02-29T00:00:00.000Z");
}

/// `home-fresh-start.process.test.ts`: "a legacy unversioned ~/.ace is renamed
/// to ~/.ace-v0 and a fresh v1 home is created".
#[test]
fn an_unversioned_home_is_renamed_aside_and_a_fresh_one_created() {
    let parent = TempDir::new("ace-home-test");
    let root = parent.path().join(".ace");
    let _ = std::fs::create_dir_all(root.join("data"));
    let _ = std::fs::write(root.join("old.txt"), "old data");
    let state = prepare(&root, 1, 1);
    assert!(matches!(state, Ok(State::Fresh { .. })));
    assert!(parent.path().join(".ace-v0").join("old.txt").exists());
    assert_eq!(
        std::fs::read_to_string(root.join(HOME_FORMAT_FILE)).unwrap_or_default(),
        render_marker(1, 1)
    );
    // The fresh home is private.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&root)
            .map(|m| m.permissions().mode())
            .unwrap_or(0);
        assert_eq!(mode & 0o777, 0o700);
    }
}

/// `home-fresh-start.process.test.ts`: "an existing ~/.ace-v0 backup is never
/// overwritten".
#[test]
fn an_existing_backup_is_never_overwritten() {
    let parent = TempDir::new("ace-home-backup");
    let root = parent.path().join(".ace");
    let _ = std::fs::create_dir_all(&root);
    let _ = std::fs::write(root.join("old.txt"), "old data");
    let _ = std::fs::create_dir_all(parent.path().join(".ace-v0"));
    let state = prepare(&root, 1, 1);
    match state {
        Ok(State::Fresh { backup, .. }) => {
            assert_eq!(backup, parent.path().join(".ace-v0.1"));
        }
        other => panic!("expected a fresh start beside the backup: {other:?}"),
    }
}

/// `home-fresh-start.process.test.ts`: "a current-format home is reused
/// untouched".
#[test]
fn a_current_format_home_is_reused_untouched() {
    let parent = TempDir::new("ace-home-reuse");
    let root = parent.path().join(".ace");
    let _ = std::fs::create_dir_all(&root);
    let _ = std::fs::write(root.join(HOME_FORMAT_FILE), render_marker(1, 1));
    let _ = std::fs::write(root.join("keep.txt"), "kept");
    assert!(matches!(prepare(&root, 1, 2), Ok(State::Reused)));
    assert!(root.join("keep.txt").exists());
    assert_eq!(
        std::fs::read_to_string(root.join(HOME_FORMAT_FILE)).unwrap_or_default(),
        render_marker(1, 1)
    );
}

/// A home containing only `features.json` keeps its flags on first start: the
/// marker is adopted, nothing is moved.
#[test]
fn a_home_holding_only_features_is_adopted() {
    let parent = TempDir::new("ace-home-adopt");
    let root = parent.path().join(".ace");
    let _ = std::fs::create_dir_all(&root);
    let _ = std::fs::write(root.join("features.json"), "{\"flags\":{}}");
    assert!(matches!(prepare(&root, 1, 7), Ok(State::Created)));
    assert!(root.join("features.json").exists());
    assert!(root.join(HOME_FORMAT_FILE).exists());
}

/// `home-format.ts`' `NewerDataError`, word for word, and nothing moved.
#[test]
fn a_newer_home_is_refused_with_the_newer_data_message_and_nothing_moves() {
    let parent = TempDir::new("ace-home-newer");
    let root = parent.path().join(".ace");
    let _ = std::fs::create_dir_all(&root);
    let _ = std::fs::write(root.join(HOME_FORMAT_FILE), render_marker(2, 1));
    let error = prepare(&root, 1, 1).err();
    let Some(HomeError::NewerData {
        stored,
        supported,
        message,
        ..
    }) = error
    else {
        panic!("a newer home is refused");
    };
    assert_eq!(stored, "ace-v2");
    assert_eq!(supported, "ace-v1");
    assert!(message.contains("This ace build is older than the data in"));
    assert!(root.join(HOME_FORMAT_FILE).exists());
}

/// `local-files.test.ts`: "an existing data directory other users can enter is
/// restricted to its owner before locking".
#[test]
#[cfg(unix)]
fn a_data_directory_others_can_enter_is_restricted_to_its_owner() {
    use std::os::unix::fs::PermissionsExt;
    let parent = TempDir::new("ace-home-mode");
    let root = parent.path().join(".ace");
    let _ = std::fs::create_dir_all(&root);
    let _ = std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755));
    assert!(secure_data_dir(&root).is_ok());
    let mode = std::fs::metadata(&root)
        .map(|m| m.permissions().mode())
        .unwrap_or(0);
    assert_eq!(mode & 0o777, 0o700);
}

/// `local-files.test.ts`: "a symlinked data directory is refused".
#[test]
#[cfg(unix)]
fn a_symlinked_data_directory_is_refused() {
    let parent = TempDir::new("ace-home-link");
    let target = parent.path().join("elsewhere");
    let _ = std::fs::create_dir_all(&target);
    let root = parent.path().join(".ace");
    let _ = std::os::unix::fs::symlink(&target, &root);
    let error = secure_data_dir(&root).err();
    assert!(
        error
            .map(|error| error.to_string().contains("symbolic link"))
            .unwrap_or(false),
        "a symbolic link is refused"
    );
}

/// `backupName`: `.ace-v0`, then `.ace-v0.1`; never an existing name.
#[test]
fn a_backup_name_never_reuses_one() {
    assert_eq!(
        backup_name(".ace", 0, |_| false).as_deref(),
        Some(".ace-v0")
    );
    assert_eq!(
        backup_name(".ace", 0, |name| name == ".ace-v0").as_deref(),
        Some(".ace-v0.1")
    );
    assert_eq!(backup_name(".ace", 0, |_| true), None);
}

/// `home-fresh-start.process.test.ts`: "a live home is never renamed": a daemon
/// still holds the old home's lock, so the fresh start refuses and nothing moves.
#[test]
fn a_live_home_is_never_renamed() {
    let parent = TempDir::new("ace-home-live");
    let root = parent.path().join(".ace");
    let _ = std::fs::create_dir_all(&root);
    let _ = std::fs::write(root.join("old.txt"), "in use");
    let lock = crate::lock::Lock::acquire(&root);
    assert!(lock.is_ok(), "the test holds the home's lock");
    let refused = prepare(&root, 1, 1);
    match refused {
        Err(HomeError::Live { message, .. }) => {
            assert!(message.contains("still using it"), "{message}");
            assert!(message.contains("Nothing was moved"), "{message}");
        }
        other => panic!("a live home is refused: {other:?}"),
    }
    assert!(root.join("old.txt").exists(), "the home was not moved");
    assert!(
        !parent.path().join(".ace-v0").exists(),
        "no backup was made"
    );
    if let Ok(lock) = lock {
        lock.release();
    }
}

/// `home-fresh-start.process.test.ts`: "a crashed old daemon's leftover lock does
/// not block the fresh start": its kernel lock is gone, so the rename proceeds.
#[test]
fn a_crashed_daemons_leftover_lock_does_not_block_the_fresh_start() {
    let parent = TempDir::new("ace-home-crashed");
    let root = parent.path().join(".ace");
    let _ = std::fs::create_dir_all(&root);
    let _ = std::fs::write(root.join("old.txt"), "old data");
    // A lock database no process holds, and a holder name naming a dead pid.
    if let Ok(connection) = ace_store::Connection::open(
        &root.join("daemon-lock.sqlite").to_string_lossy(),
        ace_store::OpenOptions::default(),
    ) {
        let _ = connection.close();
    }
    let _ = std::fs::write(root.join("daemon-lock"), "{\"pid\":4294967,\"id\":\"old\"}");
    assert!(matches!(prepare(&root, 1, 1), Ok(State::Fresh { .. })));
    assert!(parent.path().join(".ace-v0/old.txt").exists());
}

/// `home-release.process.test.ts`: "a fresh start keeps the installed release": the
/// program moves back into the fresh home while its data stays in the backup.
#[test]
fn a_fresh_start_carries_an_installed_release() {
    let parent = TempDir::new("ace-home-release");
    let root = parent.path().join(".ace");
    let release = "releases/1.2.3-darwin-arm64";
    let _ = std::fs::create_dir_all(root.join(release));
    let _ = std::fs::create_dir_all(root.join("bin"));
    let _ = std::fs::write(root.join("old.txt"), "old data");
    let _ = std::fs::write(
        root.join(release).join("release.json"),
        "{\"version\":\"1.2.3\",\"channel\":\"stable\",\"target\":\"darwin-arm64\"}",
    );
    let _ = std::fs::write(
        root.join("bin/ace"),
        super::release::render_launcher(&root, super::release::Platform::Unix).unwrap_or_default(),
    );
    let _ = std::os::unix::fs::symlink(release, root.join("current"));
    let state = prepare(&root, 1, 1);
    match state {
        Ok(State::Fresh {
            release: carried, ..
        }) => assert_eq!(carried.as_deref(), Some("1.2.3")),
        other => panic!("expected a fresh start carrying the release: {other:?}"),
    }
    assert!(
        root.join("releases/1.2.3-darwin-arm64/release.json")
            .exists()
    );
    assert!(root.join("bin/ace").exists());
    assert!(root.join("current").exists());
    assert!(parent.path().join(".ace-v0/old.txt").exists());
}

/// `home-fresh-start.ts:64`–`:65`: a file at the home path is refused with the
/// TypeScript's sentence.
#[test]
fn a_file_at_the_home_path_is_refused_as_not_a_directory() {
    let parent = TempDir::new("ace-home-file");
    let root = parent.path().join(".ace");
    let _ = std::fs::write(&root, "not a home");
    match prepare(&root, 1, 1) {
        Err(error) => {
            let message = error.to_string();
            assert!(message.contains("Refusing ace data home"), "{message}");
            assert!(message.contains("it is not a directory"), "{message}");
        }
        Ok(_) => panic!("a file is not a home"),
    }
}

/// `home-release.process.test.ts`: a launcher written for another home is not
/// carried, even when its path contains this home's as a prefix (`~/.ace2`).
#[test]
fn a_launcher_for_another_home_is_not_carried() {
    let parent = TempDir::new("ace-home-release-other");
    let root = parent.path().join(".ace");
    let other = parent.path().join(".ace2");
    let release = "releases/1.2.3-darwin-arm64";
    let _ = std::fs::create_dir_all(root.join(release));
    let _ = std::fs::create_dir_all(root.join("bin"));
    let _ = std::fs::write(root.join("old.txt"), "old data");
    let _ = std::fs::write(
        root.join(release).join("release.json"),
        "{\"version\":\"1.2.3\",\"channel\":\"stable\",\"target\":\"darwin-arm64\"}",
    );
    let _ = std::fs::write(
        root.join("bin/ace"),
        super::release::render_launcher(&other, super::release::Platform::Unix).unwrap_or_default(),
    );
    let _ = std::os::unix::fs::symlink(release, root.join("current"));
    let state = prepare(&root, 1, 1);
    match state {
        Ok(State::Fresh {
            release: carried, ..
        }) => assert_eq!(carried, None),
        other => panic!("expected a fresh start without a carried release: {other:?}"),
    }
    assert!(!root.join("bin/ace").exists());
}

/// A half-applied update is not carried (`update.json`).
#[test]
fn a_half_applied_update_is_not_carried() {
    let parent = TempDir::new("ace-home-release-update");
    let root = parent.path().join(".ace");
    let release = "releases/1.2.3-darwin-arm64";
    let _ = std::fs::create_dir_all(root.join(release));
    let _ = std::fs::create_dir_all(root.join("bin"));
    let _ = std::fs::write(root.join("old.txt"), "old data");
    let _ = std::fs::write(root.join("update.json"), "{}");
    let _ = std::fs::write(
        root.join(release).join("release.json"),
        "{\"version\":\"1.2.3\",\"channel\":\"stable\",\"target\":\"darwin-arm64\"}",
    );
    let _ = std::fs::write(
        root.join("bin/ace"),
        super::release::render_launcher(&root, super::release::Platform::Unix).unwrap_or_default(),
    );
    let _ = std::os::unix::fs::symlink(release, root.join("current"));
    match prepare(&root, 1, 1) {
        Ok(State::Fresh {
            release: carried, ..
        }) => assert_eq!(carried, None),
        other => panic!("expected no carried release: {other:?}"),
    }
}

/// The launcher is compared whole (`home-release.ts:37`–`:39`), not by the home it
/// names: a script that sets this home but is not the one `install.sh` writes is
/// another build's, and is not carried.
#[test]
fn a_launcher_that_is_not_the_installed_script_is_not_carried() {
    let parent = TempDir::new("ace-home-release-script");
    let root = parent.path().join(".ace");
    let release = "releases/1.2.3-darwin-arm64";
    let _ = std::fs::create_dir_all(root.join(release));
    let _ = std::fs::create_dir_all(root.join("bin"));
    let _ = std::fs::write(
        root.join(release).join("release.json"),
        "{\"version\":\"1.2.3\",\"channel\":\"stable\",\"target\":\"darwin-arm64\"}",
    );
    let _ = std::fs::write(
        root.join("bin/ace"),
        format!(
            "#!/bin/sh\nACE_HOME='{}'\nexport ACE_HOME\nexec \"$ACE_HOME/current/bin/node\" \"$ACE_HOME/current/ace.mjs\" \"$@\"\n",
            root.display()
        ),
    );
    let _ = std::os::unix::fs::symlink(release, root.join("current"));
    assert_eq!(
        super::release::carried_version(&root, &root, super::release::Platform::Unix),
        None
    );
}

/// `home-release.ts:73`–`:96`: on Windows `current` is a pointer file and the
/// launcher is `bin\ace.cmd`, the same batch file for every home: the whole file
/// is compared with `renderLauncher`, and a release manifest needs its channel.
#[test]
fn a_windows_home_carries_its_pointer_release() {
    let parent = TempDir::new("ace-home-release-windows");
    let backup = parent.path().join(".ace");
    // The batch file is the same for every home, so the home it is carried into differs.
    let home = parent.path().join(".ace-next");
    let release = "releases/1.2.3-win32-x64";
    let _ = std::fs::create_dir_all(backup.join(release));
    let _ = std::fs::create_dir_all(backup.join("bin"));
    let _ = std::fs::write(
        backup.join(release).join("release.json"),
        "{\"version\":\"1.2.3\",\"channel\":\"preview\",\"target\":\"win32-x64\"}",
    );
    let _ = std::fs::write(backup.join("current"), "releases/1.2.3-win32-x64\r\n");
    let launcher = super::release::render_launcher(&home, super::release::Platform::Windows)
        .unwrap_or_default();
    let _ = std::fs::write(backup.join("bin/ace.cmd"), &launcher);
    assert_eq!(
        super::release::carried_version(&backup, &home, super::release::Platform::Windows),
        Some("1.2.3".to_owned())
    );
    // A launcher that is not exactly `renderCmdLauncher` is another build's.
    let _ = std::fs::write(backup.join("bin/ace.cmd"), format!("{launcher}\r\n"));
    assert_eq!(
        super::release::carried_version(&backup, &home, super::release::Platform::Windows),
        None
    );
    // The same home, read as a POSIX home: no symlink at `current`, so no release.
    let _ = std::fs::write(
        backup.join("bin/ace.cmd"),
        super::release::render_launcher(&home, super::release::Platform::Windows)
            .unwrap_or_default(),
    );
    assert_eq!(
        super::release::carried_version(&backup, &home, super::release::Platform::Unix),
        None
    );
    // The manifest needs the channel `InstalledRelease` reads.
    let _ = std::fs::write(
        backup.join(release).join("release.json"),
        "{\"version\":\"1.2.3\",\"target\":\"win32-x64\"}",
    );
    assert_eq!(
        super::release::carried_version(&backup, &home, super::release::Platform::Windows),
        None
    );
    // A corrupt pointer file whose multi-byte UTF-8 straddles byte 256 is refused, never a panic.
    let _ = std::fs::write(
        backup.join(release).join("release.json"),
        "{\"version\":\"1.2.3\",\"channel\":\"preview\",\"target\":\"win32-x64\"}",
    );
    let _ = std::fs::write(backup.join("current"), format!("{}漢", "a".repeat(254)));
    assert_eq!(
        super::release::carried_version(&backup, &home, super::release::Platform::Windows),
        None
    );
    // Restore the valid pointer and carry the full Windows release into `home`.
    let _ = std::fs::write(backup.join("current"), "releases/1.2.3-win32-x64\r\n");
    let _ = std::fs::write(backup.join("previous"), "releases/1.2.2-win32-x64\r\n");
    let _ = std::fs::write(backup.join("old.txt"), "old data");
    let _ = std::fs::create_dir_all(&home);
    assert_eq!(
        super::release::carry_on(&backup, &home, super::release::Platform::Windows),
        Some("1.2.3".to_owned())
    );
    assert!(home.join("releases/1.2.3-win32-x64/release.json").exists());
    assert!(home.join("bin/ace.cmd").exists());
    assert!(home.join("current").exists());
    assert!(home.join("previous").exists());
    assert!(backup.join("old.txt").exists());
}

/// `home-openers.ts:110`–`:120`: a hanging `lsof` is stopped at its deadline and reports
/// no openers, even when it printed a partial pid before hanging.
#[test]
#[cfg(unix)]
fn a_hanging_lsof_times_out_and_reports_no_openers() {
    use std::os::unix::fs::PermissionsExt as _;
    let parent = TempDir::new("ace-home-lsof-timeout");
    let script = parent.path().join("slow-lsof.sh");
    let _ = std::fs::write(&script, "#!/bin/sh\nprintf '12'\nsleep 30\n");
    let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700));
    let target = parent.path().join("state.sqlite");
    let _ = std::fs::write(&target, "data");
    let began = std::time::Instant::now();
    let pids = super::claim::lsof_openers_with(
        &script,
        &[target],
        crate::bounded_command::Bounds {
            timeout: std::time::Duration::from_millis(200),
            max_bytes: 1024,
        },
    );
    assert!(
        began.elapsed() < std::time::Duration::from_secs(3),
        "hanging lsof must be bounded, took {:?}",
        began.elapsed()
    );
    assert!(
        pids.is_empty(),
        "timed-out lsof must discard partial stdout, got {pids:?}"
    );
}

/// `home-claim.ts`: an older ace (0.x keeps no daemon-lock) that still holds a
/// home's database open is refused with `OldAceRunningError`, and nothing moves.
#[test]
#[cfg(unix)]
fn an_older_ace_holding_the_home_is_refused() {
    let parent = TempDir::new("ace-home-old-ace");
    let root = parent.path().join(".ace");
    let _ = std::fs::create_dir_all(root.join("userdata"));
    let database = root.join("userdata/state.sqlite");
    let _ = std::fs::write(&database, "old ace data");
    let holder = std::process::Command::new("sh")
        .args([
            "-c",
            "exec 3<>\"$0\"; sleep 30",
            &database.display().to_string(),
        ])
        .spawn();
    let Ok(mut holder) = holder else {
        return;
    };
    std::thread::sleep(std::time::Duration::from_millis(400));
    let refused = prepare(&root, 1, 1);
    let _ = holder.kill();
    let _ = holder.wait();
    match refused {
        Err(HomeError::Live { message, pid, .. }) => {
            assert!(message.contains("older ace"), "{message}");
            assert!(message.contains("Nothing was moved"), "{message}");
            assert!(pid.is_some());
        }
        other => panic!("an older ace holding the home is refused: {other:?}"),
    }
    assert!(root.join("userdata/state.sqlite").exists());
    assert!(!parent.path().join(".ace-v0").exists());
}

/// `home-claim.ts`: a recorded pid file naming a running process refuses the home as an
/// older ace's, and nothing moves; a pid that is gone lets the fresh start through.
#[test]
#[cfg(unix)]
fn a_recorded_live_pid_refuses_the_home_and_a_stale_pid_does_not() {
    let parent = TempDir::new("ace-home-pid");
    let root = parent.path().join(".ace");
    let _ = std::fs::create_dir_all(root.join("userdata"));
    let _ = std::fs::write(root.join("userdata/state.sqlite"), "old ace data");
    let mut holder = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .expect("a live process");
    let _ = std::fs::write(root.join("daemon.pid"), holder.id().to_string());
    match prepare(&root, 1, 1) {
        Err(HomeError::Live { message, pid, .. }) => {
            assert!(message.contains("older ace"), "{message}");
            assert!(message.contains("Nothing was moved"), "{message}");
            assert_eq!(pid, Some(i64::from(holder.id())));
        }
        other => panic!("a recorded live pid is refused: {other:?}"),
    }
    assert!(root.join("userdata/state.sqlite").exists());
    assert!(!parent.path().join(".ace-v0").exists());

    let _ = holder.kill();
    let _ = holder.wait();
    // A pid that is gone records nobody: the old home is backed up and a fresh one starts.
    let _ = std::fs::write(root.join("daemon.pid"), "4294967");
    assert!(matches!(prepare(&root, 1, 1), Ok(State::Fresh { .. })));
    assert!(parent.path().join(".ace-v0/daemon.pid").exists());
}
