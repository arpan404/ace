// SPDX-License-Identifier: Apache-2.0

//! The version string stored with drafts, byte for byte what the TypeScript daemon prints.
//!
//! Versions come from the handle the bytes were read through, never from a path: on Unix the
//! metadata carries the device, inode and both times, and on Windows the open handle is asked
//! for the volume serial, file index and change time libuv reports.

use cap_std::fs::{Dir, File, Metadata, MetadataExt};
use files_safe::Root;

use crate::Error;
use crate::describe::Walks;
use crate::number::js_number;

/// The version of the entry at `path`, or `None` when there is nothing there.
///
/// Files carry their identity and times. Folders carry a digest of their whole tree, so a
/// caller can guard a later change to either kind of entry the way the daemon does.
pub fn stat_version(root: &Root, path: &str) -> Result<Option<String>, Error> {
    let (dir, name) = match crate::handle::target_parent(root, path) {
        Ok(found) => found,
        Err(error) if error.code() == "NOT_FOUND" => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(entry_version(root, &dir, &name, path, &Walks::unbounded())?.map(|found| found.version))
}

/// The version of `name` in `dir`, or `None` when nothing is there. `path` is the caller's
/// spelling, which names the entries a folder version digests and labels its errors.
///
/// A folder reports its own version beside the digest, so a caller that already holds the digest
/// can re-check the folder without walking it again; `shallow` says a walk budget stopped the
/// digest, in which case `version` is the folder's own version.
pub(crate) fn entry_version(
    root: &Root,
    dir: &Dir,
    name: &str,
    path: &str,
    walks: &Walks,
) -> Result<Option<Versioned>, Error> {
    let metadata = match dir.symlink_metadata(name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.is_dir() {
        let folder = dir.open_dir(name)?;
        let tree = crate::tree::version(root, path, &folder, walks)?;
        return Ok(Some(Versioned {
            version: tree.version,
            own: Some(tree.own),
            shallow: tree.shallow,
        }));
    }
    let own = version_of(entry_handle(dir, name, &metadata)?.as_ref(), &metadata)?;
    Ok(Some(Versioned {
        version: own.clone(),
        own: None,
        shallow: false,
    }))
}

/// One entry's version and how much of it was actually read.
pub(crate) struct Versioned {
    /// The version a client stores: a file's identity and times, or a folder's tree digest.
    pub(crate) version: String,
    /// A folder's own version, before its digest; absent for a file.
    pub(crate) own: Option<String>,
    /// True when the folder digest stopped at a walk budget.
    pub(crate) shallow: bool,
}

/// The version of `name` in `dir` from metadata the caller already read, with the handle Windows
/// needs opened only there.
pub(crate) fn version_of_entry(
    dir: &Dir,
    name: &str,
    metadata: &Metadata,
) -> Result<String, Error> {
    version_of(entry_handle(dir, name, metadata)?.as_ref(), metadata)
}

/// The version of an entry from its metadata and, on Windows, a handle to it.
pub(crate) fn version_of(handle: Option<&File>, metadata: &Metadata) -> Result<String, Error> {
    let facts = facts(handle, metadata)?;
    Ok(format!(
        "{}:{}:{}:{}:{}",
        js_number(facts.dev as f64),
        js_number(facts.ino as f64),
        js_number(metadata.len() as f64),
        js_number(facts.mtime),
        js_number(facts.ctime)
    ))
}

/// A folder's own version, read through a handle to the folder itself.
pub(crate) fn own_version(dir: &Dir) -> Result<String, Error> {
    let metadata = dir.dir_metadata()?;
    #[cfg(unix)]
    let handle = None;
    #[cfg(windows)]
    let handle = Some(crate::handle::dir_handle(dir)?);
    version_of(handle.as_ref(), &metadata)
}

/// Whether `name` in `dir` still has the identity recorded in `metadata`.
#[cfg(unix)]
pub(crate) fn still(dir: &Dir, name: &str, metadata: &Metadata) -> Result<bool, Error> {
    let again = dir.symlink_metadata(name)?;
    Ok(identity(metadata) == identity(&again))
}

/// The identity a version is anchored on.
#[cfg(unix)]
pub(crate) fn identity(metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

/// The identity of a folder, read through a handle to it: a name that is replaced by another
/// entry before the version is read never lends that entry's identity. Windows cannot rename a
/// folder while its handle is open, so it records this before publishing and checks it after.
#[cfg(windows)]
pub(crate) fn identity_of(dir: &Dir) -> Result<(u64, u64), Error> {
    let facts = files_safe::handle_facts(&crate::handle::dir_handle(dir)?)?;
    Ok((facts.0, facts.1))
}

/// The identity of an entry, read the way a version is.
#[cfg(unix)]
pub(crate) fn identity_of_entry(
    _dir: &Dir,
    _name: &str,
    metadata: &Metadata,
) -> Result<(u64, u64), Error> {
    Ok(identity(metadata))
}

#[cfg(windows)]
pub(crate) fn identity_of_entry(
    dir: &Dir,
    name: &str,
    _metadata: &Metadata,
) -> Result<(u64, u64), Error> {
    let handle = crate::handle::attribute_handle(dir, name)?;
    let facts = files_safe::handle_facts(&handle)?;
    Ok((facts.0, facts.1))
}

/// The identity of the entry a handle is open on, so a name cannot lend another entry's identity
/// between the read and the call that records it.
#[cfg(unix)]
pub(crate) fn identity_of_handle(_file: &File, metadata: &Metadata) -> Result<(u64, u64), Error> {
    Ok(identity(metadata))
}

#[cfg(windows)]
pub(crate) fn identity_of_handle(file: &File, _metadata: &Metadata) -> Result<(u64, u64), Error> {
    let facts = files_safe::handle_facts(file)?;
    Ok((facts.0, facts.1))
}

/// Whether two entries in their folders are the same entry, which a case-only rename on a
/// case-insensitive volume needs. A link is compared as itself, never followed.
pub(crate) fn same_entry(
    left_dir: &Dir,
    left_name: &str,
    right_dir: &Dir,
    right_name: &str,
) -> Result<bool, Error> {
    let left = left_dir.symlink_metadata(left_name)?;
    let right = right_dir.symlink_metadata(right_name)?;
    let left = facts(entry_handle(left_dir, left_name, &left)?.as_ref(), &left)?;
    let right = facts(
        entry_handle(right_dir, right_name, &right)?.as_ref(),
        &right,
    )?;
    Ok(left.dev == right.dev && left.ino == right.ino)
}

/// The version of the moved entry at `name`, when the name still holds the entry with `identity`.
///
/// A rename changes the change time and nothing else, so a version read through the name after
/// the move is the moved entry's only while the identity is the one recorded before it. A name
/// another program took in between has a different identity, and no version is reported for it.
pub(crate) fn moved_version(
    dir: &Dir,
    name: &str,
    identity: Option<(u64, u64)>,
) -> Result<Option<String>, Error> {
    let Some(wanted) = identity else {
        return Ok(None);
    };
    #[cfg(unix)]
    {
        let metadata = match dir.symlink_metadata(name) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file() || crate::version::identity(&metadata) != wanted {
            return Ok(None);
        }
        Ok(Some(version_of(None, &metadata)?))
    }
    #[cfg(windows)]
    {
        // One handle carries both the identity and the version, so a name another program
        // replaces between two reads can never pair one entry's identity with another's version.
        let file = match crate::handle::attribute_handle(dir, name) {
            Ok(file) => file,
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() || identity_of_handle(&file, &metadata)? != wanted {
            return Ok(None);
        }
        Ok(Some(version_of(Some(&file), &metadata)?))
    }
}

/// A version with its last field removed: a rename changes the change time and nothing else a
/// version records, so the daemon compares versions this way when it swaps a save into place or
/// checks an entry it has just moved.
pub(crate) fn without_change_time(version: &str) -> &str {
    version.rsplit_once(':').map_or(version, |(rest, _)| rest)
}

/// The identity and times a version is made of.
struct Facts {
    dev: u64,
    ino: u64,
    mtime: f64,
    ctime: f64,
}

#[cfg(unix)]
fn facts(_handle: Option<&File>, metadata: &Metadata) -> Result<Facts, Error> {
    Ok(Facts {
        dev: metadata.dev(),
        ino: metadata.ino(),
        mtime: unix_millis(metadata.mtime(), metadata.mtime_nsec()),
        ctime: unix_millis(metadata.ctime(), metadata.ctime_nsec()),
    })
}

/// The handle an entry's version needs on Windows; Unix reads everything from the metadata.
#[cfg(unix)]
fn entry_handle(_dir: &Dir, _name: &str, _metadata: &Metadata) -> Result<Option<File>, Error> {
    Ok(None)
}

/// Windows has no `dev`/`ino`: the volume serial and the file index stand in for them, and only
/// a handle can report them. The handle also carries the change time, which is what libuv puts
/// in `ctimeMs`; the write time comes from the metadata beside it.
#[cfg(windows)]
fn facts(handle: Option<&File>, metadata: &Metadata) -> Result<Facts, Error> {
    let handle = handle.ok_or_else(|| {
        Error::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "a Windows version needs the entry's handle",
        ))
    })?;
    let (dev, ino, change) = files_safe::handle_facts(handle)?;
    Ok(Facts {
        dev,
        ino,
        mtime: windows_millis(metadata.last_write_time() as i64),
        ctime: windows_millis(change),
    })
}

#[cfg(windows)]
fn entry_handle(dir: &Dir, name: &str, metadata: &Metadata) -> Result<Option<File>, Error> {
    use cap_fs_ext::DirExt;

    if metadata.is_dir() {
        return Ok(Some(crate::handle::dir_handle(
            &dir.open_dir_nofollow(name)?,
        )?));
    }
    Ok(Some(crate::handle::attribute_handle(dir, name)?))
}

/// Milliseconds since the Unix epoch, as the double Node computes from a timespec.
#[cfg(any(unix, windows))]
fn unix_millis(seconds: i64, nanoseconds: i64) -> f64 {
    seconds as f64 * 1000.0 + nanoseconds as f64 / 1e6
}

/// Node reports Windows times as Unix milliseconds: libuv turns the 100 ns ticks since 1601 into
/// seconds and nanoseconds first, keeping the sign, so doing the same keeps the printed digits
/// identical for files older than 1970.
#[cfg(windows)]
fn windows_millis(ticks: i64) -> f64 {
    const EPOCH_DIFFERENCE: i64 = 116_444_736_000_000_000;
    const TICKS_PER_SECOND: i64 = 10_000_000;
    let delta = ticks - EPOCH_DIFFERENCE;
    unix_millis(delta / TICKS_PER_SECOND, delta % TICKS_PER_SECOND * 100)
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::process::{Command, Stdio};

    use super::unix_millis;
    use crate::number::js_number;

    /// Every timestamp a version can carry must print exactly as node prints it.
    ///
    /// The two sides print the same shortest decimal for all but the halfway timestamps, which a
    /// file modified between two nanoseconds can report. This needs `node` on PATH and fails
    /// rather than skipping without it: a skipped parity test proves nothing.
    #[test]
    fn timestamps_print_as_javascript_prints_them() {
        let timestamps = timestamps();
        let javascript = javascript_prints(&timestamps);
        assert_eq!(
            javascript.len(),
            timestamps.len(),
            "node prints one line per timestamp"
        );
        for ((seconds, nanoseconds), expected) in timestamps.iter().zip(javascript) {
            assert_eq!(
                js_number(unix_millis(*seconds, *nanoseconds)),
                expected,
                "{seconds} seconds and {nanoseconds} nanoseconds must print as node prints them"
            );
        }
    }

    /// Nanoseconds at, beside and away from whole milliseconds, plus a seeded sweep of the range.
    fn timestamps() -> Vec<(i64, i64)> {
        let mut timestamps = vec![
            (1_731_800_000, 999_999_999),
            (1_731_800_000, 500_000),
            (1_731_800_000, 123_456_789),
            (1_731_800_000, 1),
            (1_731_800_000, 0),
            (1_911_493_843, 781_250),
            (-315_619_200, 123_456_789),
            (-1, 999_999_999),
            (0, 1),
            (0, 999_999_999),
        ];
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for index in 0..1_000 {
            let seconds = 1_000_000_000 + (next() % 1_000_000_000) as i64;
            let nanoseconds = (next() % 1_000_000_000) as i64;
            timestamps.push(if index % 2 == 0 {
                (seconds, nanoseconds)
            } else {
                (-seconds, nanoseconds)
            });
        }
        timestamps
    }

    /// What node prints for those timestamps, from one process, one line each.
    fn javascript_prints(timestamps: &[(i64, i64)]) -> Vec<String> {
        let script = "const lines = require('node:fs').readFileSync(0, 'utf8').split('\\n').filter(Boolean);\n\
                      process.stdout.write(lines.map((line) => {\n\
                      const [seconds, nanoseconds] = line.split(' ').map(Number);\n\
                      return String(seconds * 1000 + nanoseconds / 1e6);\n\
                      }).join('\\n'));";
        let mut child = Command::new("node")
            .arg("-e")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("node is required to check version formatting");
        let input: String = timestamps
            .iter()
            .map(|(seconds, nanoseconds)| format!("{seconds} {nanoseconds}\n"))
            .collect();
        let mut stdin = child.stdin.take().expect("a pipe to node");
        stdin
            .write_all(input.as_bytes())
            .expect("write the timestamps");
        drop(stdin);
        let output = child.wait_with_output().expect("node's answer");
        assert!(
            output.status.success(),
            "node failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("node prints UTF-8")
            .lines()
            .map(str::to_owned)
            .collect()
    }
}
