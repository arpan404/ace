// SPDX-License-Identifier: Apache-2.0
//! `tools-entry`'s downloads and unpacking: both pinned tarballs and the scrcpy server are
//! checked against their pin before anything is written, and nothing a failed, cancelled or
//! timed-out install staged is ever published under the tool's name.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine as _;
use flate2::read::GzDecoder;
use sha2::{Digest, Sha512};

use super::super::http::Client;
use super::super::scrcpy::jar::{ScrcpyRelease, scrcpy_release, verified, write_server};
use super::{
    Artifacts, Hints, INSTALL_TIMEOUT_MS, InstallRequest, ServeSimCommand, TARBALL_LIMIT,
    ToolsInstalled, install_directory, managed,
};
use crate::platform::{Code, Error};

/// A directory with the shell's private mode (0700), recursively.
fn create_dir(hints: &Hints, path: &Path) -> Result<(), Error> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|error| hints.unavailable(format!("Couldn't unpack: {error}")))
}

pub(super) fn digest_sha512_base64(bytes: &[u8]) -> String {
    format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes))
    )
}

async fn fetch(client: &Client, label: &str, url: &str, limit: u64) -> Result<Vec<u8>, Error> {
    client.get(url, limit, label).await
}

/// Unpacks one gzipped tarball, optionally dropping its first path component (`--strip-components
/// 1`). Every written path stays under `into`.
fn untar_gz(hints: &Hints, archive: &Path, into: &Path, strip: bool) -> Result<(), Error> {
    let file = fs::File::open(archive).map_err(|error| {
        hints.unavailable(format!("Couldn't unpack {}: {error}", archive.display()))
    })?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    fs::create_dir_all(into)
        .map_err(|error| hints.unavailable(format!("Couldn't unpack: {error}")))?;
    let entries = archive
        .entries()
        .map_err(|error| hints.unavailable(format!("Couldn't unpack: {error}")))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| hints.unavailable(format!("Couldn't unpack: {error}")))?;
        let path = entry
            .path()
            .map_err(|error| hints.unavailable(format!("Couldn't unpack: {error}")))?
            .into_owned();
        let relative = if strip {
            path.components().skip(1).collect::<PathBuf>()
        } else {
            path.clone()
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(hints.unavailable(format!("Couldn't unpack {}", path.display())));
        }
        let destination = into.join(&relative);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&destination)
                .map_err(|error| hints.unavailable(format!("Couldn't unpack: {error}")))?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| hints.unavailable(format!("Couldn't unpack: {error}")))?;
        }
        entry
            .unpack(&destination)
            .map_err(|error| hints.unavailable(format!("Couldn't unpack: {error}")))?;
    }
    Ok(())
}

/// The pinned serve-sim and `ws`, checked against their registry checksums and unpacked into
/// ace's tools directory, all or nothing: a half-finished install is never found, and an install
/// already in place is reused.
pub(super) fn install_serve_sim(
    hints: &Hints,
    request: &InstallRequest,
    artifacts: &Artifacts,
    serve_sim: Vec<u8>,
    ws: Vec<u8>,
    cancel: &AtomicBool,
) -> Result<ServeSimCommand, Error> {
    let directory = Path::new(&request.directory);
    let root = install_directory(&request.directory, artifacts);
    create_dir(hints, directory)?;
    let staging = directory.join(format!(".serve-sim-{}.partial", request.id));
    create_dir(hints, &staging)?;
    let result = (|| {
        let modules = staging.join("package").join("node_modules").join("ws");
        create_dir(hints, &modules)?;
        let serve_sim_tgz = staging.join("serve-sim.tgz");
        let ws_tgz = staging.join("ws.tgz");
        write_private(hints, &serve_sim_tgz, &serve_sim)?;
        write_private(hints, &ws_tgz, &ws)?;
        // npm tarballs hold everything under `package/`.
        untar_gz(hints, &serve_sim_tgz, &staging, false)?;
        untar_gz(hints, &ws_tgz, &modules, true)?;
        write_private(
            hints,
            &staging.join("package").join(".ace-install.json"),
            format!(
                "{{\"serveSim\":{},\"ws\":{}}}",
                json_string(&artifacts.serve_sim.integrity),
                json_string(&artifacts.ws.integrity)
            )
            .as_bytes(),
        )?;
        // A timed-out install never replaces the copy in place.
        if cancel.load(Ordering::SeqCst) {
            return Err(hints.timeout());
        }
        let _ = fs::remove_dir_all(&root);
        if let Err(error) = fs::rename(staging.join("package"), &root) {
            // Another install finished first with the same pinned packages.
            if managed(&request.directory, &request.node, artifacts).is_none() {
                return Err(hints.unavailable(format!("serve-sim didn't install: {error}")));
            }
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&staging);
    result?;
    managed(&request.directory, &request.node, artifacts)
        .ok_or_else(|| hints.unavailable("serve-sim didn't install".to_string()))
}

fn write_private(hints: &Hints, path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| hints.unavailable(format!("Couldn't unpack: {error}")))?;
    file.write_all(bytes)
        .map_err(|error| hints.unavailable(format!("Couldn't unpack: {error}")))
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())
}

/// The `ACE_SCRCPY_SERVER` the request names, when it is a path: the shell ignores an empty one.
fn scrcpy_override(request: &InstallRequest) -> Option<&str> {
    request
        .scrcpy_server
        .as_deref()
        .filter(|value| !value.is_empty())
}

/// The pinned server in place, through the jar's one verified write path: a download that fails
/// its checksum, and an install already past its deadline, never publish a file.
pub(super) fn install_scrcpy(
    hints: &Hints,
    request: &InstallRequest,
    release: &ScrcpyRelease,
    bytes: &[u8],
    cancel: &AtomicBool,
) -> Result<String, Error> {
    if let Some(explicit) = scrcpy_override(request) {
        if verified(Path::new(explicit), &release.sha256) {
            return Ok(explicit.to_string());
        }
        return Err(hints.scrcpy_unavailable(format!(
            "ACE_SCRCPY_SERVER is not scrcpy-server v{}",
            release.version
        )));
    }
    let path = write_server(
        Path::new(&request.directory),
        release,
        &request.id,
        bytes,
        || {
            // A timed-out install never publishes its staged file.
            if cancel.load(Ordering::SeqCst) {
                return Err(hints.timeout());
            }
            Ok(())
        },
    )
    .map_err(|error| scrcpy_error(hints, error))?;
    Ok(path.to_string_lossy().into_owned())
}

/// The live install's words for the shared write path's refusals: the scrcpy hint for a
/// download it refused, while the install's own timeout keeps its words.
fn scrcpy_error(hints: &Hints, error: Error) -> Error {
    match error {
        Error::Failed(failure) if failure.code == Code::ToolMissing => {
            hints.scrcpy_unavailable(failure.message)
        }
        other => other,
    }
}

/// A wire bound the request or the reply broke.
fn wire_issue(issue: crate::service::device_tools_wire::Issue) -> Error {
    Error::Invalid(format!("{}: {}", issue.field, issue.message))
}

/// A reply whose bounds hold, or the refusal.
fn checked(installed: ToolsInstalled) -> Result<ToolsInstalled, Error> {
    crate::service::device_tools_wire::check_installed(&installed).map_err(wire_issue)?;
    Ok(installed)
}

/// `tools-entry`'s whole job on the native runtime: make sure serve-sim (a Mac) and scrcpy's
/// server are installed, with today's URLs, checksums, limits, staging paths and atomic rename.
pub async fn install(request: InstallRequest) -> Result<ToolsInstalled, Error> {
    // The wire's bounds first: a request the schema rejects is refused before the
    // catalog, the network or the filesystem is touched.
    crate::service::device_tools_wire::check_request(&request).map_err(wire_issue)?;
    let hints = Hints::load()?;
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(INSTALL_TIMEOUT_MS));
    let artifacts = request.artifacts.clone().unwrap_or_else(super::artifacts);
    let release = request
        .scrcpy_release
        .clone()
        .unwrap_or_else(scrcpy_release);
    let needs_serve_sim =
        request.serve_sim && managed(&request.directory, &request.node, &artifacts).is_none();
    let scrcpy_path =
        Path::new(&request.directory).join(format!("scrcpy-server-v{}", release.version));
    let needs_scrcpy = request.scrcpy
        && scrcpy_override(&request).is_none()
        && !verified(&scrcpy_path, &release.sha256);
    if !needs_serve_sim && !needs_scrcpy {
        return checked(ToolsInstalled {
            serve_sim: request
                .serve_sim
                .then(|| managed(&request.directory, &request.node, &artifacts))
                .flatten(),
            scrcpy: request
                .scrcpy
                .then(|| install_scrcpy_existing(&hints, &request, &release))
                .transpose()?,
        });
    }
    // A timeout stops the waiting install from publishing; the blocking work checks this
    // immediately before its rename, so a late unpack never replaces the copy in place.
    let cancel = Arc::new(AtomicBool::new(false));
    let outcome = tokio::time::timeout(timeout, async {
        let client = Client::new().await?;
        let serve_sim = if needs_serve_sim {
            let (serve_sim_tgz, ws_tgz) = tokio::try_join!(
                fetch(
                    &client,
                    &artifacts.serve_sim.name,
                    &artifacts.serve_sim.url,
                    TARBALL_LIMIT
                ),
                fetch(
                    &client,
                    &artifacts.ws.name,
                    &artifacts.ws.url,
                    TARBALL_LIMIT
                ),
            )?;
            if digest_sha512_base64(&serve_sim_tgz) != artifacts.serve_sim.integrity {
                return Err(hints.unavailable(format!(
                    "{} {} failed its checksum",
                    artifacts.serve_sim.name, artifacts.serve_sim.version
                )));
            }
            if digest_sha512_base64(&ws_tgz) != artifacts.ws.integrity {
                return Err(hints.unavailable(format!(
                    "{} {} failed its checksum",
                    artifacts.ws.name, artifacts.ws.version
                )));
            }
            let owned = request.clone();
            let wanted = artifacts.clone();
            let stopped = cancel.clone();
            let task_hints = hints.clone();
            Some(
                tokio::task::spawn_blocking(move || {
                    install_serve_sim(
                        &task_hints,
                        &owned,
                        &wanted,
                        serve_sim_tgz,
                        ws_tgz,
                        &stopped,
                    )
                })
                .await
                .map_err(|error| {
                    hints.unavailable(format!("serve-sim didn't install: {error}"))
                })??,
            )
        } else {
            None
        };
        let scrcpy = if needs_scrcpy {
            let bytes = fetch(&client, "scrcpy-server", &release.url, release.bytes).await?;
            let owned = request.clone();
            let wanted = release.clone();
            let stopped = cancel.clone();
            let task_hints = hints.clone();
            Some(
                tokio::task::spawn_blocking(move || {
                    install_scrcpy(&task_hints, &owned, &wanted, &bytes, &stopped)
                })
                .await
                .map_err(|error| {
                    hints.scrcpy_unavailable(format!("scrcpy-server download failed: {error}"))
                })??,
            )
        } else if request.scrcpy {
            Some(install_scrcpy_existing(&hints, &request, &release)?)
        } else {
            None
        };
        checked(ToolsInstalled {
            serve_sim: serve_sim.or_else(|| {
                request
                    .serve_sim
                    .then(|| managed(&request.directory, &request.node, &artifacts))
                    .flatten()
            }),
            scrcpy,
        })
    })
    .await;
    match outcome {
        Ok(result) => result,
        Err(_) => {
            cancel.store(true, Ordering::SeqCst);
            Err(hints.timeout())
        }
    }
}

/// The scrcpy server already in place, without downloading.
fn install_scrcpy_existing(
    hints: &Hints,
    request: &InstallRequest,
    release: &ScrcpyRelease,
) -> Result<String, Error> {
    if let Some(explicit) = scrcpy_override(request) {
        if verified(Path::new(explicit), &release.sha256) {
            return Ok(explicit.to_string());
        }
        return Err(hints.scrcpy_unavailable(format!(
            "ACE_SCRCPY_SERVER is not scrcpy-server v{}",
            release.version
        )));
    }
    let path = Path::new(&request.directory).join(format!("scrcpy-server-v{}", release.version));
    let text = path.to_string_lossy().into_owned();
    if verified(Path::new(&text), &release.sha256) {
        Ok(text)
    } else {
        Err(hints.scrcpy_unavailable("No directory for the scrcpy server".to_string()))
    }
}
