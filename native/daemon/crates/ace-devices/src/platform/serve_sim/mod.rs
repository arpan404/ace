// SPDX-License-Identifier: Apache-2.0
//! `serve-sim-install`, `serve-sim-version`, `serve-sim-helpers` and the serve-sim half of
//! `tools-entry`: the pinned packages ace downloads, their checksums, the install it keeps in
//! its tools directory, and which helper a new serve-sim replaces. Downloads and unpacking run
//! on the native runtime (D3.1), never on the daemon's JavaScript thread; they live in
//! [`install`], behind the types and versions this module settles.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::scrcpy::jar::ScrcpyRelease;
use super::{Code, Error, Failure, words};

mod install;
pub use install::install;

/// serve-sim drives private CoreSimulator interfaces that change between Xcode releases, and its
/// HTTP and WebSocket routes are not a stable API. ace runs only versions it was checked
/// against; 0.1.48 left an iPhone Duo's stream black after some hours on Xcode 27.
pub const PINNED_SERVE_SIM: &str = "0.1.49-beta.139.1";

/// Every serve-sim version ace runs.
pub const SERVE_SIM_VERSIONS: &[&str] = &[PINNED_SERVE_SIM];

/// A tarball larger than this is refused before it is read in full.
pub const TARBALL_LIMIT: u64 = 32 * 1024 * 1024;

/// A download that hasn't finished in this long is stopped (slow links get a long allowance).
pub const INSTALL_TIMEOUT_MS: u64 = 5 * 60_000;

/// One npm package tarball ace downloads, pinned by version and the registry's sha512.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Artifact {
    pub name: String,
    pub version: String,
    pub url: String,
    pub integrity: String,
}

/// The serve-sim ace runs, and `ws`, the one package its bundled script imports from outside.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Artifacts {
    #[serde(rename = "serveSim")]
    pub serve_sim: Artifact,
    pub ws: Artifact,
}

/// The pinned npm artifacts, spelled exactly as the TypeScript did.
pub fn artifacts() -> Artifacts {
    Artifacts {
        serve_sim: Artifact {
            name: "serve-sim".to_string(),
            version: PINNED_SERVE_SIM.to_string(),
            url: format!("https://registry.npmjs.org/serve-sim/-/serve-sim-{PINNED_SERVE_SIM}.tgz"),
            integrity: "sha512-oWN0RJ11Vqnvr9irScNj847MsjusPzAS9YllcMsRh13Dq0feW+EUK0XEOKIJe7dsq0Wh7tHgXw449+BOzmRwCA==".to_string(),
        },
        ws: Artifact {
            name: "ws".to_string(),
            version: "8.22.0".to_string(),
            url: "https://registry.npmjs.org/ws/-/ws-8.22.0.tgz".to_string(),
            integrity: "sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg==".to_string(),
        },
    }
}

/// How to run serve-sim: ace's Node with its script first, then serve-sim's own arguments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServeSimCommand {
    pub command: String,
    pub args: Vec<String>,
}

/// What a tools install left in place.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct ToolsInstalled {
    #[serde(rename = "serveSim", skip_serializing_if = "Option::is_none")]
    pub serve_sim: Option<ServeSimCommand>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scrcpy: Option<String>,
}

/// One tools install, as `tools-entry` read its request.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    /// ace's tools directory, inside its home.
    pub directory: String,
    /// The daemon's Node, which runs serve-sim's script.
    pub node: String,
    pub serve_sim: bool,
    pub scrcpy: bool,
    /// The pinned npm packages; tests substitute their own.
    #[serde(default)]
    pub artifacts: Option<Artifacts>,
    /// The pinned scrcpy release; tests substitute their own.
    #[serde(default)]
    pub scrcpy_release: Option<ScrcpyRelease>,
    /// The shell's id for the staging directory, so concurrent installs never share one.
    pub id: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// `ACE_SCRCPY_SERVER`, passed explicitly: the device's own setting names a verified copy.
    #[serde(default)]
    pub scrcpy_server: Option<String>,
}

/// The catalog's tool words, resolved once per install; a missing key is a build error.
#[derive(Debug, Clone)]
struct Hints {
    download: String,
    scrcpy: String,
    timeout: String,
}

impl Hints {
    fn load() -> Result<Self, Error> {
        let required = |key: &str| {
            words::hint(key).map(str::to_string).ok_or_else(|| {
                Error::Invalid(format!("the device catalog names no tool word for {key}"))
            })
        };
        Ok(Self {
            download: required("downloadHint")?,
            scrcpy: required("scrcpyHint")?,
            timeout: required("downloadTimeout")?,
        })
    }

    fn unavailable(&self, message: String) -> Error {
        Error::Failed(Failure {
            code: Code::ToolMissing,
            message,
            hint: self.download.clone(),
        })
    }

    fn scrcpy_unavailable(&self, message: String) -> Error {
        Error::Failed(Failure {
            code: Code::ToolMissing,
            message,
            hint: self.scrcpy.clone(),
        })
    }

    /// The refusal a download that ran past its budget returns, wherever it stood.
    fn timeout(&self) -> Error {
        Error::Failed(Failure {
            code: Code::Timeout,
            message: self.timeout.clone(),
            hint: self.download.clone(),
        })
    }
}

/// `serveSimVersion`'s parse: the version a serve-sim executable printed, when it is one.
pub fn version(output: &str) -> Option<String> {
    let text = output.trim();
    let text = text.strip_prefix('v').unwrap_or(text);
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) if !pre.is_empty() => (core, Some(pre)),
        Some(_) => return None,
        None => (text, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    if let Some(pre) = pre
        && !pre
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
    {
        return None;
    }
    Some(text.to_string())
}

/// `serveSimSupported`: ace runs only the versions it was checked against.
pub fn supported(version: Option<&str>) -> bool {
    version.is_some_and(|version| SERVE_SIM_VERSIONS.contains(&version))
}

/// `managedServeSim`'s directory for the pinned packages.
pub fn install_directory(directory: &str, artifacts: &Artifacts) -> PathBuf {
    Path::new(directory).join(format!("serve-sim-{}", artifacts.serve_sim.version))
}

#[derive(Debug, Deserialize)]
struct Marker {
    #[serde(rename = "serveSim")]
    serve_sim: String,
    ws: String,
}

/// ace's own serve-sim, when an install of the pinned packages is in place.
pub fn managed(directory: &str, node: &str, artifacts: &Artifacts) -> Option<ServeSimCommand> {
    let root = install_directory(directory, artifacts);
    let marker: Marker =
        serde_json::from_str(&fs::read_to_string(root.join(".ace-install.json")).ok()?).ok()?;
    if marker.serve_sim != artifacts.serve_sim.integrity || marker.ws != artifacts.ws.integrity {
        return None;
    }
    let script = root.join("dist").join("serve-sim.js");
    if !fs::metadata(&script).ok()?.is_file() {
        return None;
    }
    Some(ServeSimCommand {
        command: node.to_string(),
        args: vec![script.to_string_lossy().into_owned()],
    })
}

/// `replacesHelper`: a helper started by `command_line` runs a copy ace downloaded of another
/// version. Helpers from any other serve-sim belong to the person and are always kept.
pub fn replaces_helper(command_line: &str, version: &str) -> bool {
    let mut rest = command_line;
    while let Some(at) = rest.find("/serve-sim-") {
        let after = &rest[at + "/serve-sim-".len()..];
        let end = after.find("/dist/serve-sim.js").filter(|end| {
            let tail = &after[*end + "/dist/serve-sim.js".len()..];
            tail.is_empty() || tail.starts_with(' ') || tail.starts_with('\t')
        });
        if let Some(end) = end
            && is_version(&after[..end])
        {
            return after[..end] != *version;
        }
        rest = &rest[at + 1..];
    }
    false
}

/// A version as serves-sim spells one: three numbers and an optional `-prerelease`.
fn is_version(text: &str) -> bool {
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) if !pre.is_empty() => (core, Some(pre)),
        Some(_) => return false,
        None => (text, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return false;
    }
    pre.is_none_or(|pre| {
        pre.bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
    })
}

#[cfg(test)]
#[path = "install_tests.rs"]
mod install_tests;
#[cfg(test)]
mod tests;
