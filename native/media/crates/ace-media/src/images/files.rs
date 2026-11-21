// SPDX-License-Identifier: Apache-2.0
//! File inputs (ADR 0201 §5), read only from inside the directory the daemon named at start
//! (`--root`, its data directory): the path is walked from that directory's handle one name at
//! a time without following a link (`openat` with `O_NOFOLLOW`), the file is opened without
//! blocking and read only if it is a regular file, so a link, a FIFO or a device can't hang or
//! redirect a worker. A job's files together hold at most [`MAX_JOB_FILE_BYTES`].
use media_image::{Failed, ImageFailure};
use media_wire::image::ImageInput;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// The most one file input may hold, whatever the job allows.
pub const MAX_FILE_BYTES: u32 = 32 * 1024 * 1024;
/// The most a job's file inputs may hold together.
pub const MAX_JOB_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn unreadable(message: impl Into<String>) -> Failed {
    Failed::new(ImageFailure::Unreadable, message)
}

/// The directory file inputs must be inside, as named and as resolved.
pub struct FileRoot {
    named: Option<PathBuf>,
    resolved: Option<PathBuf>,
}

impl FileRoot {
    pub fn new(root: Option<&Path>) -> Self {
        Self {
            named: root.map(Path::to_path_buf),
            resolved: root.and_then(|r| std::fs::canonicalize(r).ok()),
        }
    }

    /// The names under the root, refusing anything outside it or with `..` in it.
    fn names<'a>(&self, path: &'a Path) -> Result<(&Path, Vec<&'a std::ffi::OsStr>), Failed> {
        let resolved = self
            .resolved
            .as_deref()
            .ok_or_else(|| unreadable("This image process reads no files: it has no root."))?;
        let inside = [self.named.as_deref(), Some(resolved)]
            .into_iter()
            .flatten()
            .find_map(|root| path.strip_prefix(root).ok())
            .ok_or_else(|| {
                unreadable("The image file is outside the directory ace-media reads.")
            })?;
        let names: Option<Vec<_>> = inside
            .components()
            .map(|c| match c {
                Component::Normal(name) => Some(name),
                _ => None,
            })
            .collect();
        match names {
            Some(names) if !names.is_empty() => Ok((resolved, names)),
            _ => Err(unreadable(
                "The image file's path isn't a plain path inside the root.",
            )),
        }
    }

    /// Each file input's bytes, in order, checking `expired` before each read.
    pub fn read_all(
        &self,
        inputs: &[ImageInput],
        expired: &dyn Fn() -> bool,
    ) -> Result<Vec<Vec<u8>>, Failed> {
        let mut left = MAX_JOB_FILE_BYTES;
        let mut files = Vec::new();
        for input in inputs {
            let ImageInput::File { path, max_bytes } = input else {
                continue;
            };
            if expired() {
                return Err(Failed::new(
                    ImageFailure::Deadline,
                    "The image job ran past its deadline.",
                ));
            }
            let cap = u64::from((*max_bytes).min(MAX_FILE_BYTES)).min(left);
            let bytes = self.read(Path::new(path), cap)?;
            left -= bytes.len() as u64;
            files.push(bytes);
        }
        Ok(files)
    }

    fn read(&self, path: &Path, cap: u64) -> Result<Vec<u8>, Failed> {
        let (root, names) = self.names(path)?;
        let file = open_inside(root, &names)?;
        let meta = file
            .metadata()
            .map_err(|e| unreadable(format!("The image file could not be read: {}.", e.kind())))?;
        if !meta.is_file() {
            return Err(unreadable("The image input isn't a regular file."));
        }
        if meta.len() > cap {
            return Err(Failed::too_large(format!(
                "The image file is larger than the {cap} bytes this job may read."
            )));
        }
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        file.take(cap + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| unreadable(format!("The image file could not be read: {}.", e.kind())))?;
        if bytes.len() as u64 > cap {
            return Err(Failed::too_large(
                "The image file grew past its bound while read.",
            ));
        }
        Ok(bytes)
    }
}

/// `root/names…`, each directory opened from the last one's handle, never following a link.
#[cfg(unix)]
#[allow(unsafe_code)]
fn open_inside(root: &Path, names: &[&std::ffi::OsStr]) -> Result<std::fs::File, Failed> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    let c = |bytes: &[u8]| CString::new(bytes).map_err(|_| unreadable("The image path has a NUL."));
    let failed = |what: &str| {
        let e = std::io::Error::last_os_error();
        unreadable(format!(
            "The image file could not be opened ({what}): {}.",
            e.kind()
        ))
    };
    let root = c(root.as_os_str().as_bytes())?;
    // SAFETY: a valid NUL-terminated path; the result is checked before it is owned.
    let fd = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(failed("root"));
    }
    // SAFETY: `fd` was just opened and is owned by nothing else.
    let mut dir = unsafe { OwnedFd::from_raw_fd(fd) };
    let (last, dirs) = names
        .split_last()
        .ok_or_else(|| unreadable("The image path names no file."))?;
    for name in dirs {
        let name = c(name.as_bytes())?;
        // SAFETY: `dir` is an open directory and `name` a valid NUL-terminated name.
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(failed("a folder on its path"));
        }
        // SAFETY: as above.
        dir = unsafe { OwnedFd::from_raw_fd(fd) };
    }
    let name = c(last.as_bytes())?;
    // SAFETY: as above. O_NONBLOCK: opening a FIFO returns at once instead of waiting.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(failed("the file"));
    }
    // SAFETY: as above.
    Ok(std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) }))
}

/// Windows: each name on the way is checked not to be a link (a reparse point) before the file
/// is opened, and the open itself doesn't follow one.
#[cfg(not(unix))]
fn open_inside(root: &Path, names: &[&std::ffi::OsStr]) -> Result<std::fs::File, Failed> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let mut path = root.to_path_buf();
    for name in names {
        path.push(name);
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| unreadable(format!("The image file could not be read: {}.", e.kind())))?;
        if meta.file_type().is_symlink() {
            return Err(unreadable("The image path goes through a link."));
        }
    }
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&path)
        .map_err(|e| unreadable(format!("The image file could not be opened: {}.", e.kind())))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn input(path: &Path, max_bytes: u32) -> ImageInput {
        ImageInput::File {
            path: path.to_string_lossy().into_owned(),
            max_bytes,
        }
    }
    fn reason(root: &FileRoot, inputs: &[ImageInput]) -> Option<ImageFailure> {
        root.read_all(inputs, &|| false).err().map(|f| f.reason)
    }

    #[test]
    fn only_regular_files_inside_the_root_are_read_and_never_through_a_link() -> std::io::Result<()>
    {
        let base = std::env::temp_dir().join(format!("ace-media-files-{}", std::process::id()));
        let root = base.join("root");
        std::fs::create_dir_all(root.join("blobs"))?;
        std::fs::write(root.join("blobs/a"), b"inside")?;
        std::fs::write(base.join("outside"), b"secret")?;
        std::os::unix::fs::symlink(base.join("outside"), root.join("blobs/link"))?;
        std::os::unix::fs::symlink(&base, root.join("up"))?;
        let fifo = root.join("blobs/fifo");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()?
            .success();
        let files = FileRoot::new(Some(&root));

        assert_eq!(
            files
                .read_all(&[input(&root.join("blobs/a"), 64)], &|| false)
                .ok(),
            Some(vec![b"inside".to_vec()])
        );
        assert_eq!(
            reason(&files, &[input(&base.join("outside"), 64)]),
            Some(ImageFailure::Unreadable)
        );
        assert_eq!(
            reason(&files, &[input(&root.join("blobs/../../outside"), 64)]),
            Some(ImageFailure::Unreadable)
        );
        assert_eq!(
            reason(&files, &[input(&root.join("blobs/link"), 64)]),
            Some(ImageFailure::Unreadable)
        );
        assert_eq!(
            reason(&files, &[input(&root.join("up/outside"), 64)]),
            Some(ImageFailure::Unreadable)
        );
        if made {
            // Opened without blocking and refused: a FIFO never holds a worker.
            assert_eq!(
                reason(&files, &[input(&fifo, 64)]),
                Some(ImageFailure::Unreadable)
            );
        }
        assert_eq!(
            reason(&files, &[input(&root.join("blobs/a"), 3)]),
            Some(ImageFailure::TooLarge)
        );
        assert_eq!(
            reason(&FileRoot::new(None), &[input(&root.join("blobs/a"), 64)]),
            Some(ImageFailure::Unreadable)
        );
        assert_eq!(
            files
                .read_all(&[input(&root.join("blobs/a"), 64)], &|| true)
                .err()
                .map(|f| f.reason),
            Some(ImageFailure::Deadline)
        );
        std::fs::remove_dir_all(&base)
    }
}
