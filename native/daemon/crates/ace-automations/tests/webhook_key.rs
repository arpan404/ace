// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! Ports the (b) cases of `apps/daemon/src/automation-webhook-key`: a symlink, a FIFO, mode,
//! owner and size. The foreign-owner case can't be built without changing users; the own-owner
//! acceptance is asserted instead.

#![cfg(unix)]

use std::os::unix::fs::{PermissionsExt, symlink};

use ace_automations::webhook_key::{ensure_key, load_key};
use tempfile::tempdir;

fn path() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempdir().expect("temp");
    let path = dir.path().join("automation-webhooks.key");
    (dir, path)
}

#[test]
fn makes_a_32_byte_owner_only_key_and_loads_it_back() {
    let (_dir, path) = path();
    assert_eq!(load_key(&path).expect("missing is none"), None);
    let key = [7u8; 32];
    assert_eq!(ensure_key(&path, key).expect("create"), key);
    let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert_eq!(load_key(&path).expect("load"), Some(key));
    // The other store made it first: its key is used, not replaced.
    assert_eq!(ensure_key(&path, [9u8; 32]).expect("existing"), key);
}

#[test]
fn refuses_a_symlink() {
    let (_dir, path) = path();
    std::fs::write(&path, [1u8; 32]).expect("target");
    let link = path.with_file_name("link");
    symlink(&path, &link).expect("symlink");
    let error = load_key(&link).expect_err("symlink");
    assert!(
        error.to_string().contains("can't be opened safely"),
        "{error}"
    );
}

#[test]
fn refuses_a_fifo_without_blocking() {
    let (_dir, path) = path();
    let status = std::process::Command::new("mkfifo")
        .arg(&path)
        .status()
        .expect("mkfifo");
    assert!(status.success());
    let error = load_key(&path).expect_err("fifo");
    assert!(
        error.to_string().contains("isn't a regular file"),
        "{error}"
    );
}

#[test]
fn refuses_a_key_others_can_read() {
    let (_dir, path) = path();
    std::fs::write(&path, [1u8; 32]).expect("write");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");
    let error = load_key(&path).expect_err("mode");
    assert!(error.to_string().contains("mode 0600"), "{error}");
}

#[test]
fn refuses_the_wrong_size() {
    let (_dir, path) = path();
    std::fs::write(&path, [1u8; 31]).expect("write");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod");
    let error = load_key(&path).expect_err("size");
    assert!(error.to_string().contains("32-byte key"), "{error}");
}
