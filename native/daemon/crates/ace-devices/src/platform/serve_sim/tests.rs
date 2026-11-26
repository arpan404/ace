// SPDX-License-Identifier: Apache-2.0
//! `serve-sim-version` and `serve-sim-helpers`: the version a helper printed, which helper a new
//! serve-sim replaces, and an install found only with its marker and script.

use std::fs;
use std::path::PathBuf;

use super::*;

fn scratch(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("ace-serve-sim-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("scratch");
    path
}

#[test]
fn a_version_is_the_one_a_serve_sim_printed() {
    assert_eq!(
        version("v0.1.49-beta.139.1\n"),
        Some(PINNED_SERVE_SIM.to_string())
    );
    assert_eq!(version(" 0.1.48 "), Some("0.1.48".to_string()));
    assert_eq!(version("serve-sim 0.1.49"), None);
    assert_eq!(version("0.1"), None);
    assert!(!supported(None));
    assert!(supported(Some(PINNED_SERVE_SIM)));
    assert!(!supported(Some("0.1.48")));
}

#[test]
fn only_a_managed_helper_of_another_version_is_replaced() {
    assert!(replaces_helper(
        "/usr/bin/node /home/a/.ace/tools/serve-sim-0.1.48/dist/serve-sim.js -l ABCD",
        PINNED_SERVE_SIM
    ));
    assert!(!replaces_helper(
        "/usr/bin/node /home/a/.ace/tools/serve-sim-0.1.49-beta.139.1/dist/serve-sim.js --x",
        PINNED_SERVE_SIM
    ));
    assert!(!replaces_helper(
        "/usr/local/bin/serve-sim -l ABCD",
        PINNED_SERVE_SIM
    ));
}

#[test]
fn a_managed_install_is_found_only_with_matching_integrity_and_script() {
    let root = scratch("managed");
    let artifacts = artifacts();
    assert!(managed(&root.to_string_lossy(), "/bin/node", &artifacts).is_none());
    let install = install_directory(&root.to_string_lossy(), &artifacts);
    fs::create_dir_all(install.join("dist")).expect("dist");
    fs::write(install.join("dist/serve-sim.js"), b"script").expect("script");
    fs::write(
        install.join(".ace-install.json"),
        format!(
            "{{\"serveSim\":\"{}\",\"ws\":\"{}\"}}",
            artifacts.serve_sim.integrity, artifacts.ws.integrity
        ),
    )
    .expect("marker");
    let command = managed(&root.to_string_lossy(), "/bin/node", &artifacts).expect("managed");
    assert_eq!(command.command, "/bin/node");
    assert!(command.args[0].ends_with("dist/serve-sim.js"));
    let _ = fs::remove_dir_all(&root);
}
