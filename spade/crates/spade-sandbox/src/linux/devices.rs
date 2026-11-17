//! The command's dedicated pty, as the namespace init received it among the command's stdio,
//! opened by its `/dev/pts` path for its Landlock rule.
use rustix::fs::{FileType, Mode, OFlags};
use std::os::fd::{AsRawFd, OwnedFd};

/// The `/dev/pts` nodes of the terminals among `fds`, each checked to be the same object.
pub fn terminals(fds: &[OwnedFd]) -> Vec<OwnedFd> {
    fds.iter()
        .filter_map(|fd| {
            let link = format!("/proc/self/fd/{}", fd.as_raw_fd());
            let path = std::fs::read_link(&link).ok()?;
            let name = path.strip_prefix("/dev/pts").ok()?.to_str()?;
            if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let original =
                rustix::fs::open(&link, OFlags::PATH | OFlags::CLOEXEC, Mode::empty()).ok()?;
            let target = rustix::fs::open(
                &path,
                OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .ok()?;
            let before = rustix::fs::fstat(original).ok()?;
            let after = rustix::fs::fstat(&target).ok()?;
            (FileType::from_raw_mode(after.st_mode) == FileType::CharacterDevice
                && before.st_dev == after.st_dev
                && before.st_ino == after.st_ino)
                .then_some(target)
        })
        .collect()
}
