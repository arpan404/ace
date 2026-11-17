//! Authorize metadata using the very write-grant objects installed in Landlock.
use rustix::fs::{FileType, Mode, OFlags, ResolveFlags};
use rustix::io::Errno;
use std::collections::HashSet;
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::Path;

type Id = (u64, u64);
#[derive(Default)]
pub struct Grants {
    directories: HashSet<Id>,
    files: HashSet<Id>,
    pins: Vec<OwnedFd>,
}
#[allow(clippy::unnecessary_cast)]
fn id(fd: &OwnedFd) -> Result<Id, Errno> {
    let s = rustix::fs::fstat(fd)?;
    Ok((s.st_dev as u64, s.st_ino as u64))
}
const PATH: OFlags = OFlags::PATH.union(OFlags::NOFOLLOW).union(OFlags::CLOEXEC);

impl Grants {
    pub fn add(&mut self, fd: &OwnedFd) -> Result<(), Errno> {
        let kind = FileType::from_raw_mode(rustix::fs::fstat(fd)?.st_mode);
        match kind {
            FileType::Directory => {
                self.directories.insert(id(fd)?);
            }
            FileType::RegularFile | FileType::Fifo | FileType::Socket => {
                self.files.insert(id(fd)?);
            }
            _ => return Ok(()),
        }
        self.pins.push(rustix::io::dup(fd)?);
        Ok(())
    }
    pub fn authorize(&self, target: OwnedFd, parent: OwnedFd) -> Result<OwnedFd, Errno> {
        let kind = FileType::from_raw_mode(rustix::fs::fstat(&target)?.st_mode);
        if !matches!(
            kind,
            FileType::Directory
                | FileType::RegularFile
                | FileType::Fifo
                | FileType::Socket
                | FileType::Symlink
        ) {
            return Err(Errno::PERM);
        }
        if self.files.contains(&id(&target)?) {
            return Ok(target);
        }
        let mut dir = if kind == FileType::Directory {
            rustix::io::dup(&target)?
        } else {
            parent
        };
        loop {
            let here = id(&dir)?;
            if self.directories.contains(&here) {
                return Ok(target);
            }
            let above = rustix::fs::openat(&dir, "..", PATH | OFlags::DIRECTORY, Mode::empty())?;
            if id(&above)? == here {
                return Err(Errno::PERM);
            }
            dir = above;
        }
    }
    pub fn path(&self, base: OwnedFd, path: &Path) -> Result<OwnedFd, Errno> {
        if path.as_os_str().is_empty() {
            return self.fd(base);
        }
        if path.file_name().is_none() {
            let target = rustix::fs::openat2(
                &base,
                path,
                PATH | OFlags::DIRECTORY,
                Mode::empty(),
                ResolveFlags::NO_SYMLINKS,
            )?;
            let parent = rustix::io::dup(&target)?;
            return self.authorize(target, parent);
        }
        let parent = path.parent().ok_or(Errno::PERM)?;
        let name = path.file_name().ok_or(Errno::PERM)?;
        let dir = rustix::fs::openat2(
            &base,
            if parent.as_os_str().is_empty() {
                Path::new(".")
            } else {
                parent
            },
            PATH | OFlags::DIRECTORY,
            Mode::empty(),
            ResolveFlags::NO_SYMLINKS,
        )?;
        let target =
            rustix::fs::openat2(&dir, name, PATH, Mode::empty(), ResolveFlags::NO_SYMLINKS)?;
        self.authorize(target, dir)
    }
    pub fn fd(&self, target: OwnedFd) -> Result<OwnedFd, Errno> {
        if FileType::from_raw_mode(rustix::fs::fstat(&target)?.st_mode) == FileType::Directory {
            let parent = rustix::io::dup(&target)?;
            return self.authorize(target, parent);
        }
        let path = std::fs::read_link(format!("/proc/self/fd/{}", target.as_raw_fd()))
            .map_err(|_| Errno::PERM)?;
        let base = rustix::fs::open("/", PATH | OFlags::DIRECTORY, Mode::empty())?;
        let reopened = self.path(base, &path)?;
        if id(&reopened)? != id(&target)? {
            return Err(Errno::PERM);
        }
        Ok(target)
    }
}
