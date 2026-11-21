// SPDX-License-Identifier: Apache-2.0

//! `fingerprint` from `@ace/native-session`: `dev:ino:size:mtimeMs:ctimeMs`, printed as Node and
//! Bun print them, so an index the TypeScript reader wrote is still current.

use std::fs::Metadata;

use history_text::js;

/// `mtimeMs`: seconds times 1000 plus nanoseconds over a million, in floating point as Node.
pub fn mtime_ms(meta: &Metadata) -> f64 {
    let (seconds, nanos) = times(meta).0;
    seconds as f64 * 1000.0 + nanos as f64 / 1e6
}

#[cfg(unix)]
fn times(meta: &Metadata) -> ((i64, i64), (i64, i64)) {
    use std::os::unix::fs::MetadataExt;
    (
        (meta.mtime(), meta.mtime_nsec()),
        (meta.ctime(), meta.ctime_nsec()),
    )
}

#[cfg(not(unix))]
fn times(meta: &Metadata) -> ((i64, i64), (i64, i64)) {
    let at = |time: std::io::Result<std::time::SystemTime>| {
        time.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or((0, 0), |d| {
                (d.as_secs() as i64, i64::from(d.subsec_nanos()))
            })
    };
    (at(meta.modified()), at(meta.modified()))
}

#[cfg(unix)]
fn identity(meta: &Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

/// Windows has no stable file index in std; a Windows index rescans once after the move.
#[cfg(not(unix))]
fn identity(_meta: &Metadata) -> (u64, u64) {
    (0, 0)
}

/// The fingerprint string.
pub fn fingerprint(meta: &Metadata) -> String {
    let (dev, ino) = identity(meta);
    let ((ms, mn), (cs, cn)) = times(meta);
    let ms_of = |s: i64, n: i64| s as f64 * 1000.0 + n as f64 / 1e6;
    format!(
        "{}:{}:{}:{}:{}",
        js::number(dev as f64),
        js::number(ino as f64),
        meta.len(),
        js::number(ms_of(ms, mn)),
        js::number(ms_of(cs, cn))
    )
}
