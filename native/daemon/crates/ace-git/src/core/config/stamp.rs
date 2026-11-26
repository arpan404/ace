// SPDX-License-Identifier: Apache-2.0
//! A source list's stamp (`config-facts.ts`'s stamp half, G2c): file identity and times, so a
//! cache is reused exactly while nothing Git reads has changed.

/// One stamped source list: a stable string over every file's identity and times, plus the
/// newest mtime/ctime seen, which decides whether the sources are still settling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub stamp: String,
    pub newest_ms: i64,
}

/// Stamps `paths`, or `None` when a path exists but cannot be read. A directory contributes its
/// identity only: its times move with every lock file inside it.
pub fn stamp_of(paths: &[String]) -> Option<Stamp> {
    let mut newest = 0i64;
    let mut parts: Vec<String> = Vec::with_capacity(paths.len());
    for path in paths {
        let info = match std::fs::symlink_metadata(path) {
            Ok(info) => info,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                parts.push("-".to_owned());
                continue;
            }
            Err(error) => {
                // ENOTDIR: a parent that used to be a directory is a file now.
                if error.raw_os_error() == Some(libc::ENOTDIR) {
                    parts.push("-".to_owned());
                    continue;
                }
                return None;
            }
        };
        if info.is_dir() {
            parts.push(format!("d:{}", identity(&info)));
            continue;
        }
        let (mtime, ctime) = times(&info);
        newest = newest.max(mtime).max(ctime);
        parts.push(format!(
            "f:{}:{}:{mtime}:{ctime}",
            identity(&info),
            info.len()
        ));
    }
    Some(Stamp {
        stamp: parts.join("\0"),
        newest_ms: newest,
    })
}

#[cfg(unix)]
fn identity(info: &std::fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}:{:o}", info.dev(), info.ino(), info.mode())
}

#[cfg(not(unix))]
fn identity(info: &std::fs::Metadata) -> String {
    use std::time::UNIX_EPOCH;
    let created = info
        .created()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_nanos())
        .unwrap_or(0);
    format!("0:0:{:o}:{created}", info.permissions().readonly() as u8)
}

#[cfg(unix)]
fn times(info: &std::fs::Metadata) -> (i64, i64) {
    use std::os::unix::fs::MetadataExt;
    let ms = |seconds: i64, nanos: i64| {
        seconds
            .saturating_mul(1_000)
            .saturating_add(nanos / 1_000_000)
    };
    (
        ms(info.mtime(), info.mtime_nsec()),
        ms(info.ctime(), info.ctime_nsec()),
    )
}

#[cfg(not(unix))]
fn times(info: &std::fs::Metadata) -> (i64, i64) {
    use std::time::UNIX_EPOCH;
    let ms = |time: std::io::Result<std::time::SystemTime>| {
        time.ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_millis() as i64)
            .unwrap_or(0)
    };
    (ms(info.modified()), ms(info.created()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_settled_sources_stamp_keeps_identity_and_times_apart() {
        let directory = std::env::temp_dir().join(format!(
            "ace-g2c-config-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&directory).expect("directory");
        let file = directory.join("config");
        std::fs::write(&file, "[user]\n").expect("file");
        let paths = vec![
            file.to_string_lossy().into_owned(),
            directory.to_string_lossy().into_owned(),
            directory.join("missing").to_string_lossy().into_owned(),
        ];
        let first = stamp_of(&paths).expect("stamped");
        let second = stamp_of(&paths).expect("stamped");
        assert_eq!(first, second);
        assert!(first.newest_ms > 0);
        // A change to the file moves the stamp; a missing path contributes `-`.
        std::fs::write(&file, "[user]\n\tname = x\n").expect("write");
        let third = stamp_of(&paths).expect("stamped");
        assert_ne!(first.stamp, third.stamp);
        assert!(third.stamp.ends_with("\0-"), "{}", third.stamp);
        std::fs::remove_dir_all(&directory).expect("cleanup");
    }
}
