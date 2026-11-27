// SPDX-License-Identifier: Apache-2.0
//! The device tools wire's bounds (`device-tools-wire.ts`).
//!
//! `device-tools.process` (b) is the install's own proof; these cases cover the
//! schema bounds the internal message must keep.

use super::{
    MAX_ARGS, MAX_ARTIFACT_NAME, check_artifact, check_command, check_installed, check_request,
};
use crate::platform::serve_sim::{Artifact, InstallRequest, ServeSimCommand, artifacts};

fn artifact() -> Artifact {
    artifacts().serve_sim
}

fn request() -> InstallRequest {
    InstallRequest {
        directory: String::from("/home/ace/.ace/tools"),
        node: String::from("/home/ace/.ace/bin/node"),
        serve_sim: true,
        scrcpy: true,
        artifacts: None,
        scrcpy_release: None,
        id: String::from("install-1"),
        timeout_ms: None,
        scrcpy_server: None,
    }
}

#[test]
fn the_pinned_artifacts_pass_their_own_bounds() {
    check_artifact("serveSim.name", &artifact()).expect("the pinned artifact");
    check_request(&request()).expect("the request");
}

#[test]
fn an_artifact_keeps_its_name_version_url_and_integrity() {
    let mut bad = artifact();
    bad.name = String::new();
    assert_eq!(
        check_artifact("serveSim.name", &bad)
            .expect_err("empty")
            .field,
        "serveSim.name"
    );

    let mut bad = artifact();
    bad.name = "a".repeat(MAX_ARTIFACT_NAME + 1);
    assert!(check_artifact("serveSim.name", &bad).is_err());

    let mut bad = artifact();
    bad.version = String::new();
    assert_eq!(
        check_artifact("serveSim.name", &bad)
            .expect_err("empty")
            .field,
        "version"
    );

    let mut bad = artifact();
    bad.url = String::from("serve-sim-1.0.0.tgz");
    assert_eq!(
        check_artifact("serveSim.name", &bad)
            .expect_err("relative")
            .field,
        "url"
    );

    let mut bad = artifact();
    bad.integrity = String::from("sha256-nope");
    assert_eq!(
        check_artifact("serveSim.name", &bad)
            .expect_err("integrity")
            .field,
        "integrity"
    );
}

#[test]
fn the_request_needs_a_directory_and_a_node_path() {
    let mut bad = request();
    bad.directory = String::new();
    assert_eq!(check_request(&bad).expect_err("empty").field, "directory");

    let mut bad = request();
    bad.node = "n".repeat(super::MAX_PATH + 1);
    assert_eq!(check_request(&bad).expect_err("long").field, "node");

    // A caller's own artifacts are checked too.
    let mut bad = request();
    let mut artifacts = artifacts();
    artifacts.ws.integrity = String::from("md5-nope");
    bad.artifacts = Some(artifacts);
    assert_eq!(
        check_request(&bad).expect_err("integrity").field,
        "integrity"
    );
}

#[test]
fn a_reply_names_a_command_and_at_most_eight_arguments() {
    let command = ServeSimCommand {
        command: String::from("/home/ace/.ace/bin/node"),
        args: vec![String::from("serve-sim")],
    };
    check_command(&command).expect("a command");

    let bad = ServeSimCommand {
        command: String::new(),
        args: Vec::new(),
    };
    assert_eq!(
        check_command(&bad).expect_err("empty").field,
        "serveSim.command"
    );

    let bad = ServeSimCommand {
        command: String::from("node"),
        args: vec![String::new(); MAX_ARGS + 1],
    };
    assert_eq!(
        check_command(&bad).expect_err("many").field,
        "serveSim.args"
    );
}

#[test]
fn a_reply_that_names_a_scrcpy_path_must_name_a_real_one() {
    let installed = crate::platform::serve_sim::ToolsInstalled {
        serve_sim: None,
        scrcpy: Some(String::from("/home/ace/.ace/tools/scrcpy-server-v3.3.1")),
    };
    check_installed(&installed).expect("a real path");

    let empty = crate::platform::serve_sim::ToolsInstalled {
        serve_sim: None,
        scrcpy: Some(String::new()),
    };
    assert_eq!(check_installed(&empty).expect_err("empty").field, "scrcpy");

    let too_many_args = crate::platform::serve_sim::ToolsInstalled {
        serve_sim: Some(ServeSimCommand {
            command: String::from("node"),
            args: vec![String::from("x"); MAX_ARGS + 1],
        }),
        scrcpy: None,
    };
    assert_eq!(
        check_installed(&too_many_args).expect_err("args").field,
        "serveSim.args"
    );
}

#[tokio::test]
async fn the_install_entry_refuses_a_request_its_schema_rejects() {
    // The entry point checks the request before it reads the catalog, the network
    // or the filesystem.
    let mut bad = request();
    bad.node = String::new();
    let refused = crate::platform::serve_sim::install(bad)
        .await
        .expect_err("refused");
    assert!(matches!(refused, crate::platform::Error::Invalid(_)));
}
