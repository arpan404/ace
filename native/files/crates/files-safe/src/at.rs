// SPDX-License-Identifier: Apache-2.0

//! Whether a relative path, resolved from the root right now, is a file the caller already has
//! open: the proof a read-only walker takes after opening a file and before reading it.
//!
//! The name is resolved from the root handle with no link followed anywhere on the way and never
//! leaving the root, so a folder above the file that was moved out of the checkout, or replaced by
//! a link to somewhere else, does not lead back to the open file. Where the kernel can resolve a
//! whole path that way in one call it does: `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
//! RESOLVE_NO_MAGICLINKS` on Linux, `fstatat` with `AT_SYMLINK_NOFOLLOW_ANY` on macOS. Elsewhere,
//! or where that call is unavailable (an old kernel, a seccomp filter), the folder is walked from
//! the root the way [`crate::Root::open_dir_unlinked`] walks it, refusing a link at any step, and
//! the leaf looked up without following it.

use std::io;

use cap_std::fs::{File, Metadata};

use crate::Root;

/// The answer of a one-call resolution, or `None` when the platform could not make the call.
type Answer = Option<bool>;

/// Whether `rel` names `file` (whose metadata is `opened`) right now; see the module docs.
pub(crate) fn is_at(root: &Root, rel: &str, file: &File, opened: &Metadata) -> bool {
    let Ok(rel) = Root::check(rel) else {
        return false;
    };
    if rel.is_empty() || !root_still_named(root) {
        return false;
    }
    match one_call(root, rel, opened) {
        Some(answer) => answer,
        None => walked(root, rel, file, opened),
    }
}

/// Whether the root's path still names the folder its handle holds, so a root moved away and
/// replaced by a link cannot lend its name to another tree. One lookup: the handle's own identity
/// was read when the root opened.
#[cfg(unix)]
fn root_still_named(root: &Root) -> bool {
    use crate::identity::Identity;
    use std::os::unix::fs::MetadataExt;

    let Some(held) = root.identity() else {
        return root.still_ours().is_ok();
    };
    std::fs::metadata(root.path())
        .is_ok_and(|named| Identity::from_parts(named.dev(), named.ino()) == held)
}

#[cfg(not(unix))]
fn root_still_named(root: &Root) -> bool {
    root.still_ours().is_ok()
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn one_call(root: &Root, rel: &str, opened: &Metadata) -> Answer {
    use cap_fs_ext::MetadataExt;
    use rustix::fs::{Mode, OFlags, ResolveFlags, fstat, openat2};
    use rustix::io::Errno;

    let resolve = ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS;
    let flags = OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    match openat2(root.dir(), rel, flags, Mode::empty(), resolve) {
        Ok(named) => Some(
            fstat(&named)
                .is_ok_and(|named| named.st_dev == opened.dev() && named.st_ino == opened.ino()),
        ),
        // No openat2 here, or a filter refuses it: walk instead.
        Err(Errno::NOSYS | Errno::PERM | Errno::INVAL) => None,
        Err(_) => Some(false),
    }
}

#[cfg(target_vendor = "apple")]
fn one_call(root: &Root, rel: &str, opened: &Metadata) -> Answer {
    use cap_fs_ext::MetadataExt;
    use rustix::fs::{AtFlags, statat};
    use rustix::io::Errno;

    // `AT_SYMLINK_NOFOLLOW_ANY` from <sys/fcntl.h> (macOS 11 and later): refuse a link in any
    // component, not only the last. Neither rustix nor libc names it yet.
    const SYMLINK_NOFOLLOW_ANY: u32 = 0x0800;
    let flags = AtFlags::SYMLINK_NOFOLLOW | AtFlags::from_bits_retain(SYMLINK_NOFOLLOW_ANY);
    match statat(root.dir(), rel, flags) {
        Ok(named) => Some(
            u64::try_from(named.st_dev).is_ok_and(|device| device == opened.dev())
                && named.st_ino == opened.ino(),
        ),
        // A macOS without the flag rejects it: walk instead.
        Err(Errno::INVAL) => None,
        Err(_) => Some(false),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
fn one_call(_root: &Root, _rel: &str, _opened: &Metadata) -> Answer {
    None
}

/// The same proof by walking: the folder from the root refusing a link at any step, then the leaf
/// without following it.
fn walked(root: &Root, rel: &str, file: &File, opened: &Metadata) -> bool {
    let (folder, leaf) = match rel.rsplit_once('/') {
        Some(split) => split,
        None => ("", rel),
    };
    let Ok(dir) = crate::walk::open_folder_unlinked(root, folder) else {
        return false;
    };
    same_entry(&dir, leaf, file, opened).unwrap_or(false)
}

#[cfg(unix)]
fn same_entry(
    dir: &cap_std::fs::Dir,
    leaf: &str,
    _file: &File,
    opened: &Metadata,
) -> io::Result<bool> {
    use cap_fs_ext::MetadataExt;

    let named = dir.symlink_metadata(leaf)?;
    Ok(named.dev() == opened.dev() && named.ino() == opened.ino())
}

/// Windows has no inode in a path's metadata, so the leaf is opened, never following a link, and
/// the two handles compared.
#[cfg(windows)]
fn same_entry(
    dir: &cap_std::fs::Dir,
    leaf: &str,
    file: &File,
    _opened: &Metadata,
) -> io::Result<bool> {
    use cap_fs_ext::{FollowSymlinks, OpenOptions, OpenOptionsFollowExt};

    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let named = dir.open_with(leaf, &options)?;
    let named = same_file::Handle::from_file(named.into_std())?;
    let opened = same_file::Handle::from_file(file.try_clone()?.into_std())?;
    Ok(named == opened)
}

#[cfg(not(any(unix, windows)))]
fn same_entry(
    dir: &cap_std::fs::Dir,
    leaf: &str,
    _file: &File,
    _opened: &Metadata,
) -> io::Result<bool> {
    dir.symlink_metadata(leaf).map(|_| true)
}

#[cfg(all(test, unix))]
mod tests {
    use super::walked;
    use crate::Root;

    #[test]
    fn the_walked_proof_refuses_a_folder_reached_through_a_link_inside_the_root() {
        let dir = tempfile::tempdir().expect("a temp dir");
        std::fs::create_dir_all(dir.path().join("real/d")).expect("folders");
        std::fs::write(dir.path().join("real/d/one.txt"), "one").expect("a file");
        let root = Root::open(dir.path()).expect("the root opens");
        let file = root
            .open_dir("real/d")
            .expect("the folder")
            .open("one.txt")
            .expect("the file");
        let metadata = file.metadata().expect("its metadata");
        assert!(
            walked(&root, "real/d/one.txt", &file, &metadata),
            "the real path is there"
        );

        std::os::unix::fs::symlink("real", dir.path().join("a")).expect("a link inside");
        assert!(!walked(&root, "a/d/one.txt", &file, &metadata));
    }
}
