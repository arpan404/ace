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
    assert_eq!(backup_name(".ace", 0, |_| false), ".ace-v0");
    assert_eq!(
        backup_name(".ace", 0, |name| name == ".ace-v0"),
        ".ace-v0.1"
    );
}
