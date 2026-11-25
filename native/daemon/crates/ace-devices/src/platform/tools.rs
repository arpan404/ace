// SPDX-License-Identifier: Apache-2.0
//! `device-tools.ts` and `tools-entry.ts`: what a device-tools download asks for, and the one
//! refusal before it starts. The download, its checksums and the unpacking stay with the shell
//! (they are I/O); this crate decides the request, its wants and its budget.

use serde::Serialize;

use super::{Refusal, words};

/// A download that hasn't finished in this long is stopped (slow links get a long allowance).
pub const INSTALL_TIMEOUT_MS: u64 = 5 * 60_000;

/// What one tools download fetches: serve-sim on a Mac, the scrcpy server everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ToolsPlan {
    #[serde(rename = "serveSim")]
    pub serve_sim: bool,
    pub scrcpy: bool,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: u64,
}

/// `downloadTools`: a directory and the daemon's Node are required; a Mac also downloads
/// serve-sim. The plan is the same request `tools-entry` reads.
pub fn download_plan(
    platform: &str,
    directory: Option<&str>,
    node: Option<&str>,
) -> Result<ToolsPlan, Refusal> {
    if directory.is_none_or(str::is_empty) || node.is_none_or(str::is_empty) {
        return Err(words::refusal("toolsNowhere"));
    }
    Ok(ToolsPlan {
        serve_sim: platform == "darwin",
        scrcpy: true,
        timeout_ms: INSTALL_TIMEOUT_MS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mac_downloads_serve_sim_and_every_host_downloads_the_scrcpy_server() {
        assert_eq!(
            download_plan("darwin", Some("/home/tools"), Some("/usr/bin/node")).expect("mac"),
            ToolsPlan {
                serve_sim: true,
                scrcpy: true,
                timeout_ms: 300_000,
            }
        );
        assert_eq!(
            download_plan("linux", Some("/home/tools"), Some("/usr/bin/node")).expect("linux"),
            ToolsPlan {
                serve_sim: false,
                scrcpy: true,
                timeout_ms: 300_000,
            }
        );
    }

    #[test]
    fn a_platform_with_nowhere_to_keep_tools_refuses_before_any_download() {
        for (directory, node) in [
            (None, Some("/usr/bin/node")),
            (Some("/home/tools"), None),
            (Some(""), Some("/usr/bin/node")),
        ] {
            let refused = download_plan("darwin", directory, node).expect_err("nowhere");
            assert_eq!(refused.code.as_str(), "tool_missing");
            assert_eq!(refused.message, "ace has nowhere to keep device tools");
        }
    }
}
