// SPDX-License-Identifier: Apache-2.0
//! `serve-sim-install`, `serve-sim-version`, `serve-sim-helpers` and the serve-sim half of
//! `tools-entry`: the pinned packages ace downloads, their checksums, the install it keeps in
//! its tools directory, and which helper a new serve-sim replaces. Downloads and unpacking run
//! on the native runtime (D3.1), never on the daemon's JavaScript thread.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine as _;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};

use super::http::Client;
use super::{Code, Error, Failure, words};

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

/// The catalog's tool hint, which the TypeScript raises the same way.
fn download_hint() -> String {
    words::hint("downloadHint").unwrap_or_default().to_string()
}

/// The catalog's scrcpy hint.
fn scrcpy_hint() -> String {
    words::hint("scrcpyHint").unwrap_or_default().to_string()
}

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

/// The upstream scrcpy server ace speaks to: client and server must be the same release, so
/// the version, size and SHA-256 are pinned together.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ScrcpyRelease {
    pub version: String,
    pub bytes: u64,
    pub sha256: String,
    pub url: String,
}

/// The pinned scrcpy release.
pub fn scrcpy_release() -> ScrcpyRelease {
    ScrcpyRelease {
        version: "5.0.1".to_string(),
        bytes: 733_930,
        sha256: "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536".to_string(),
        url: "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1"
            .to_string(),
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

fn unavailable(message: String) -> Error {
    Error::Failed(Failure {
        code: Code::ToolMissing,
        message,
        hint: download_hint(),
    })
}

fn scrcpy_unavailable(message: String) -> Error {
    Error::Failed(Failure {
        code: Code::ToolMissing,
        message,
        hint: scrcpy_hint(),
    })
}

/// The refusal a download that ran past its budget returns, wherever it stood.
fn timeout_error() -> Error {
    Error::Failed(Failure {
        code: Code::Timeout,
        message: words::hint("downloadTimeout")
            .unwrap_or("The device tools download took too long")
            .to_string(),
        hint: download_hint(),
    })
}

/// A directory with the shell's private mode (0700), recursively.
fn create_dir(path: &Path) -> Result<(), Error> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|error| unavailable(format!("Couldn't unpack: {error}")))
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

/** A version as serves-sim spells one: three numbers and an optional `-prerelease`. */
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

fn digest_sha512_base64(bytes: &[u8]) -> String {
    format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes))
    )
}

fn digest_sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn fetch(client: &Client, label: &str, url: &str, limit: u64) -> Result<Vec<u8>, Error> {
    client.get(url, limit, label).await
}

/// Unpacks one gzipped tarball, optionally dropping its first path component (`--strip-components
/// 1`). Every written path stays under `into`.
fn untar_gz(archive: &Path, into: &Path, strip: bool) -> Result<(), Error> {
    let file = fs::File::open(archive)
        .map_err(|error| unavailable(format!("Couldn't unpack {}: {error}", archive.display())))?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    fs::create_dir_all(into).map_err(|error| unavailable(format!("Couldn't unpack: {error}")))?;
    let entries = archive
        .entries()
        .map_err(|error| unavailable(format!("Couldn't unpack: {error}")))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| unavailable(format!("Couldn't unpack: {error}")))?;
        let path = entry
            .path()
            .map_err(|error| unavailable(format!("Couldn't unpack: {error}")))?
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
            return Err(unavailable(format!("Couldn't unpack {}", path.display())));
        }
        let destination = into.join(&relative);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&destination)
                .map_err(|error| unavailable(format!("Couldn't unpack: {error}")))?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| unavailable(format!("Couldn't unpack: {error}")))?;
        }
        entry
            .unpack(&destination)
            .map_err(|error| unavailable(format!("Couldn't unpack: {error}")))?;
    }
    Ok(())
}

/// The pinned serve-sim and `ws`, checked against their registry checksums and unpacked into
/// ace's tools directory, all or nothing: a half-finished install is never found, and an install
/// already in place is reused.
fn install_serve_sim(
    request: &InstallRequest,
    artifacts: &Artifacts,
    serve_sim: Vec<u8>,
    ws: Vec<u8>,
    cancel: &AtomicBool,
) -> Result<ServeSimCommand, Error> {
    let directory = Path::new(&request.directory);
    let root = install_directory(&request.directory, artifacts);
    create_dir(directory)?;
    let staging = directory.join(format!(".serve-sim-{}.partial", request.id));
    create_dir(&staging)?;
    let result = (|| {
        let modules = staging.join("package").join("node_modules").join("ws");
        create_dir(&modules)?;
        let serve_sim_tgz = staging.join("serve-sim.tgz");
        let ws_tgz = staging.join("ws.tgz");
        write_private(&serve_sim_tgz, &serve_sim)?;
        write_private(&ws_tgz, &ws)?;
        // npm tarballs hold everything under `package/`.
        untar_gz(&serve_sim_tgz, &staging, false)?;
        untar_gz(&ws_tgz, &modules, true)?;
        write_private(
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
            return Err(timeout_error());
        }
        let _ = fs::remove_dir_all(&root);
        if let Err(error) = fs::rename(staging.join("package"), &root) {
            // Another install finished first with the same pinned packages.
            if managed(&request.directory, &request.node, artifacts).is_none() {
                return Err(unavailable(format!("serve-sim didn't install: {error}")));
            }
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&staging);
    result?;
    managed(&request.directory, &request.node, artifacts)
        .ok_or_else(|| unavailable("serve-sim didn't install".to_string()))
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| unavailable(format!("Couldn't unpack: {error}")))?;
    file.write_all(bytes)
        .map_err(|error| unavailable(format!("Couldn't unpack: {error}")))
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())
}

/// The pinned server already in place (verified by checksum), or a downloaded and verified copy.
fn install_scrcpy(
    request: &InstallRequest,
    release: &ScrcpyRelease,
    bytes: &[u8],
    cancel: &AtomicBool,
) -> Result<String, Error> {
    if let Some(explicit) = request.scrcpy_server.as_deref() {
        if verified(explicit, &release.sha256) {
            return Ok(explicit.to_string());
        }
        return Err(scrcpy_unavailable(format!(
            "ACE_SCRCPY_SERVER is not scrcpy-server v{}",
            release.version
        )));
    }
    let path = Path::new(&request.directory).join(format!("scrcpy-server-v{}", release.version));
    let path_text = path.to_string_lossy().into_owned();
    create_dir(Path::new(&request.directory))?;
    let partial = PathBuf::from(format!("{path_text}.{}.partial", request.id));
    let result = write_private_bytes(&partial, bytes).and_then(|()| {
        // A timed-out install never publishes its partial file.
        if cancel.load(Ordering::SeqCst) {
            return Err(timeout_error());
        }
        fs::rename(&partial, &path)
            .map_err(|error| scrcpy_unavailable(format!("scrcpy-server download failed: {error}")))
    });
    let _ = fs::remove_file(&partial);
    result?;
    Ok(path_text)
}

fn write_private_bytes(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    write_private(path, bytes).map_err(|error| match error {
        Error::Failed(failure) => scrcpy_unavailable(failure.message),
        other => other,
    })
}

fn verified(path: &str, sha256: &str) -> bool {
    fs::read(path)
        .map(|bytes| digest_sha256_hex(&bytes) == sha256)
        .unwrap_or(false)
}

/// `tools-entry`'s whole job on the native runtime: make sure serve-sim (a Mac) and scrcpy's
/// server are installed, with today's URLs, checksums, limits, staging paths and atomic rename.
pub async fn install(request: InstallRequest) -> Result<ToolsInstalled, Error> {
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(INSTALL_TIMEOUT_MS));
    let artifacts = request.artifacts.clone().unwrap_or_else(artifacts);
    let release = request
        .scrcpy_release
        .clone()
        .unwrap_or_else(scrcpy_release);
    let needs_serve_sim =
        request.serve_sim && managed(&request.directory, &request.node, &artifacts).is_none();
    let scrcpy_path =
        Path::new(&request.directory).join(format!("scrcpy-server-v{}", release.version));
    let needs_scrcpy = request.scrcpy
        && request.scrcpy_server.is_none()
        && !verified(&scrcpy_path.to_string_lossy(), &release.sha256);
    if !needs_serve_sim && !needs_scrcpy {
        return Ok(ToolsInstalled {
            serve_sim: request
                .serve_sim
                .then(|| managed(&request.directory, &request.node, &artifacts))
                .flatten(),
            scrcpy: request
                .scrcpy
                .then(|| install_scrcpy_existing(&request, &release))
                .transpose()?,
        });
    }
    let client = Client::new()?;
    // A timeout stops the waiting install from publishing; the blocking work checks this
    // immediately before its rename, so a late unpack never replaces the copy in place.
    let cancel = Arc::new(AtomicBool::new(false));
    let outcome = tokio::time::timeout(timeout, async {
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
                return Err(unavailable(format!(
                    "{} {} failed its checksum",
                    artifacts.serve_sim.name, artifacts.serve_sim.version
                )));
            }
            if digest_sha512_base64(&ws_tgz) != artifacts.ws.integrity {
                return Err(unavailable(format!(
                    "{} {} failed its checksum",
                    artifacts.ws.name, artifacts.ws.version
                )));
            }
            let owned = request.clone();
            let wanted = artifacts.clone();
            let stopped = cancel.clone();
            Some(
                tokio::task::spawn_blocking(move || {
                    install_serve_sim(&owned, &wanted, serve_sim_tgz, ws_tgz, &stopped)
                })
                .await
                .map_err(|error| unavailable(format!("serve-sim didn't install: {error}")))??,
            )
        } else {
            None
        };
        let scrcpy = if needs_scrcpy {
            let bytes = fetch(&client, "scrcpy-server", &release.url, release.bytes).await?;
            if digest_sha256_hex(&bytes) != release.sha256 {
                return Err(scrcpy_unavailable(
                    "scrcpy-server download failed its checksum".to_string(),
                ));
            }
            let owned = request.clone();
            let wanted = release.clone();
            let stopped = cancel.clone();
            Some(
                tokio::task::spawn_blocking(move || {
                    install_scrcpy(&owned, &wanted, &bytes, &stopped)
                })
                .await
                .map_err(|error| {
                    scrcpy_unavailable(format!("scrcpy-server download failed: {error}"))
                })??,
            )
        } else if request.scrcpy {
            Some(install_scrcpy_existing(&request, &release)?)
        } else {
            None
        };
        Ok(ToolsInstalled {
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
            Err(timeout_error())
        }
    }
}

/// The scrcpy server already in place, without downloading.
fn install_scrcpy_existing(
    request: &InstallRequest,
    release: &ScrcpyRelease,
) -> Result<String, Error> {
    if let Some(explicit) = request.scrcpy_server.as_deref() {
        if verified(explicit, &release.sha256) {
            return Ok(explicit.to_string());
        }
        return Err(scrcpy_unavailable(format!(
            "ACE_SCRCPY_SERVER is not scrcpy-server v{}",
            release.version
        )));
    }
    let path = Path::new(&request.directory).join(format!("scrcpy-server-v{}", release.version));
    let text = path.to_string_lossy().into_owned();
    if verified(&text, &release.sha256) {
        Ok(text)
    } else {
        Err(scrcpy_unavailable(
            "No directory for the scrcpy server".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::thread::{self, JoinHandle};

    fn tarball(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut decoder = Vec::new();
        {
            let encoder =
                flate2::write::GzEncoder::new(&mut decoder, flate2::Compression::default());
            let mut builder = tar::Builder::new(encoder);
            for (path, bytes) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, path, *bytes).expect("tar");
            }
            builder.finish().expect("finish");
        }
        decoder
    }

    fn integrity(bytes: &[u8]) -> String {
        digest_sha512_base64(bytes)
    }

    /// A local HTTP server that answers each route by request path and counts requests.
    fn server(
        routes: Vec<(&'static str, Vec<u8>)>,
    ) -> (
        String,
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
        JoinHandle<()>,
    ) {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("addr");
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let handle = thread::spawn(move || {
            for _ in 0..routes.len() {
                let Ok((stream, _)) = listener.accept() else {
                    return;
                };
                seen.fetch_add(1, Ordering::SeqCst);
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    request.push_str(&line);
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                }
                let path = request.split_whitespace().nth(1).unwrap_or("/");
                let body = routes
                    .iter()
                    .find(|(route, _)| *route == path)
                    .map(|(_, body)| body.clone());
                let mut stream = stream;
                let (status, body) = match body {
                    Some(body) => ("200 OK", body),
                    None => ("404 Not Found", Vec::new()),
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        (format!("http://{address}"), count, handle)
    }

    /// A port nothing listens on: a download that reached it would fail.
    fn dead_url() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("addr");
        drop(listener);
        format!("http://{address}")
    }

    /// A server that accepts and never answers, for a deadline test.
    fn hanging_server() -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("addr");
        let handle = thread::spawn(move || {
            if let Ok((_stream, _)) = listener.accept() {
                thread::sleep(std::time::Duration::from_millis(200));
            }
        });
        (format!("http://{address}"), handle)
    }

    fn request(directory: &Path, artifacts: Artifacts) -> InstallRequest {
        InstallRequest {
            directory: directory.to_string_lossy().into_owned(),
            node: "/bin/node".to_string(),
            serve_sim: true,
            scrcpy: false,
            artifacts: Some(artifacts),
            scrcpy_release: None,
            id: "test".to_string(),
            timeout_ms: None,
            scrcpy_server: None,
        }
    }

    fn pinned(base: &str, serve_sim: &[u8], ws: &[u8]) -> Artifacts {
        Artifacts {
            serve_sim: Artifact {
                name: "serve-sim".to_string(),
                version: PINNED_SERVE_SIM.to_string(),
                url: format!("{base}/serve-sim.tgz"),
                integrity: integrity(serve_sim),
            },
            ws: Artifact {
                name: "ws".to_string(),
                version: "8.22.0".to_string(),
                url: format!("{base}/ws.tgz"),
                integrity: integrity(ws),
            },
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("ace-serve-sim-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("scratch");
        path
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
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

    #[test]
    fn the_pinned_tarballs_are_downloaded_checked_and_unpacked_into_one_atomic_install() {
        let root = scratch("install");
        let serve_sim = tarball(&[
            ("package/dist/serve-sim.js", b"script"),
            ("package/package.json", b"{}"),
        ]);
        let ws = tarball(&[("package/index.js", b"ws")]);
        let (base, count, handle) = server(vec![
            ("/serve-sim.tgz", serve_sim.clone()),
            ("/ws.tgz", ws.clone()),
        ]);
        let artifacts = pinned(&base, &serve_sim, &ws);
        let installed = block_on(install(request(&root, artifacts.clone()))).expect("install");
        let command = installed.serve_sim.expect("serve-sim");
        let script = PathBuf::from(&command.args[0]);
        assert!(script.is_file());
        assert!(script.ends_with("dist/serve-sim.js"));
        assert!(script.starts_with(&root));
        let installed_root = install_directory(&root.to_string_lossy(), &artifacts);
        assert!(installed_root.join("node_modules/ws/index.js").is_file());
        handle.join().expect("server");
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 2);
        // A second install is reused: the server gets no third request.
        let (_idle, idle_count, idle_handle) = server(Vec::new());
        let again = block_on(install(request(&root, artifacts))).expect("reuse");
        assert_eq!(again.serve_sim.expect("serve-sim").args, command.args);
        idle_handle.join().expect("idle server");
        assert_eq!(idle_count.load(std::sync::atomic::Ordering::SeqCst), 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_checksum_mismatch_leaves_no_install_behind() {
        let root = scratch("checksum");
        let serve_sim = tarball(&[("package/dist/serve-sim.js", b"script")]);
        let ws = tarball(&[("package/index.js", b"ws")]);
        let (base, _count, handle) = server(vec![
            ("/serve-sim.tgz", serve_sim.clone()),
            ("/ws.tgz", ws.clone()),
        ]);
        let mut artifacts = pinned(&base, &serve_sim, &ws);
        artifacts.serve_sim.integrity = "sha512-AAAA".to_string();
        let error = block_on(install(request(&root, artifacts.clone()))).expect_err("checksum");
        let message = error.to_string();
        assert!(message.contains("failed its checksum"), "{message}");
        assert!(!install_directory(&root.to_string_lossy(), &artifacts).exists());
        handle.join().expect("server");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_download_over_the_limit_is_refused_before_it_is_read_in_full() {
        let root = scratch("limit");
        let (base, _count, handle) = server(vec![("/scrcpy", b"0123456789".to_vec())]);
        let release = ScrcpyRelease {
            version: "9.9.9".to_string(),
            bytes: 4,
            sha256: digest_sha256_hex(b"0123456789"),
            url: format!("{base}/scrcpy"),
        };
        let mut asked = request(&root, artifacts());
        asked.serve_sim = false;
        asked.scrcpy = true;
        asked.scrcpy_release = Some(release);
        let error = block_on(install(asked)).expect_err("too large");
        assert!(error.to_string().contains("too large"), "{error}");
        handle.join().expect("server");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_verified_scrcpy_server_is_reused_and_a_wrong_explicit_one_is_refused() {
        let root = scratch("scrcpy");
        let bytes = b"server";
        let release = ScrcpyRelease {
            version: "9.9.9".to_string(),
            bytes: bytes.len() as u64,
            sha256: digest_sha256_hex(bytes),
            url: "http://127.0.0.1:1/never".to_string(),
        };
        let path = root.join("scrcpy-server-v9.9.9");
        fs::write(&path, bytes).expect("jar");
        let mut asked = request(&root, artifacts());
        asked.serve_sim = false;
        asked.scrcpy = true;
        asked.scrcpy_release = Some(release.clone());
        let installed = block_on(install(asked)).expect("installed");
        assert_eq!(
            installed.scrcpy.as_deref(),
            Some(path.to_string_lossy().as_ref())
        );

        let explicit = root.join("explicit-server");
        fs::write(&explicit, b"other").expect("explicit");
        let mut refused = request(&root, artifacts());
        refused.serve_sim = false;
        refused.scrcpy = true;
        refused.scrcpy_release = Some(release);
        refused.scrcpy_server = Some(explicit.to_string_lossy().into_owned());
        let error = block_on(install(refused)).expect_err("wrong explicit");
        assert!(
            error.to_string().contains("is not scrcpy-server v9.9.9"),
            "{error}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_verified_override_is_used_without_any_request() {
        let root = scratch("override");
        let bytes = b"override";
        let path = root.join("custom-server");
        fs::write(&path, bytes).expect("override");
        let release = ScrcpyRelease {
            version: "9.9.9".to_string(),
            bytes: bytes.len() as u64,
            sha256: digest_sha256_hex(bytes),
            url: format!("{}/scrcpy", dead_url()),
        };
        let mut asked = request(&root, artifacts());
        asked.serve_sim = false;
        asked.scrcpy = true;
        asked.scrcpy_release = Some(release);
        asked.scrcpy_server = Some(path.to_string_lossy().into_owned());
        let installed = block_on(install(asked)).expect("override");
        assert_eq!(
            installed.scrcpy.as_deref(),
            Some(path.to_string_lossy().as_ref())
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_wrong_override_is_refused_with_the_shells_message_without_a_request() {
        let root = scratch("override-bad");
        let path = root.join("custom-server");
        fs::write(&path, b"other").expect("override");
        let release = ScrcpyRelease {
            version: "9.9.9".to_string(),
            bytes: 7,
            sha256: digest_sha256_hex(b"override"),
            url: format!("{}/scrcpy", dead_url()),
        };
        let mut asked = request(&root, artifacts());
        asked.serve_sim = false;
        asked.scrcpy = true;
        asked.scrcpy_release = Some(release);
        asked.scrcpy_server = Some(path.to_string_lossy().into_owned());
        let error = block_on(install(asked)).expect_err("wrong override");
        assert!(
            error
                .to_string()
                .contains("ACE_SCRCPY_SERVER is not scrcpy-server v9.9.9"),
            "{error}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_cancelled_install_does_not_publish_its_unpacked_copy() {
        let root = scratch("cancelled");
        let artifacts = artifacts();
        let asked = request(&root, artifacts.clone());
        let cancel = AtomicBool::new(true);
        let serve_sim = tarball(&[("package/dist/serve-sim.js", b"script")]);
        let ws = tarball(&[("package/index.js", b"ws")]);
        let error =
            install_serve_sim(&asked, &artifacts, serve_sim, ws, &cancel).expect_err("cancelled");
        assert!(error.to_string().contains("took too long"), "{error}");
        assert!(!install_directory(&root.to_string_lossy(), &artifacts).exists());
        assert!(!root.join(".serve-sim-test.partial").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_timed_out_install_publishes_nothing() {
        let root = scratch("timeout");
        let (base, handle) = hanging_server();
        let serve_sim = tarball(&[("package/dist/serve-sim.js", b"script")]);
        let ws = tarball(&[("package/index.js", b"ws")]);
        let artifacts = pinned(&base, &serve_sim, &ws);
        let mut asked = request(&root, artifacts.clone());
        asked.timeout_ms = Some(30);
        let error = block_on(install(asked)).expect_err("timeout");
        assert!(error.to_string().starts_with("timeout:"), "{error}");
        assert!(!install_directory(&root.to_string_lossy(), &artifacts).exists());
        handle.join().expect("server");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_install_uses_the_id_the_shell_named_for_its_staging_directory() {
        let root = scratch("id");
        let artifacts = artifacts();
        let mut asked = request(&root, artifacts.clone());
        asked.id = "from-the-shell".to_string();
        let cancel = AtomicBool::new(true);
        let serve_sim = tarball(&[("package/dist/serve-sim.js", b"script")]);
        let ws = tarball(&[("package/index.js", b"ws")]);
        let _ = install_serve_sim(&asked, &artifacts, serve_sim, ws, &cancel);
        assert!(!root.join(".serve-sim-from-the-shell.partial").exists());
        assert!(!root.join(".serve-sim-test.partial").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
