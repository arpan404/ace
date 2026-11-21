// SPDX-License-Identifier: Apache-2.0
//! File inputs (ADR 0201 §5), read only from inside the directory the daemon named at start
//! (`--root`, its data directory). That directory is opened once, when the process starts, and
//! its handle is kept: every input is walked from it one name at a time without following a
//! link, so neither a link nor a directory swapped in under the same name later can send a read
//! elsewhere. The file is opened without blocking and read only if it is a regular file, so a
//! FIFO or a device can't hang a worker. A job's files together hold at most
//! [`MAX_JOB_FILE_BYTES`]. Hard links are not refused: the inputs are files ace itself wrote
//! under its data directory (ADR 0201 §5).
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

/// The directory file inputs must be inside: its names, and its handle, opened at start.
pub struct FileRoot {
    named: Option<PathBuf>,
    resolved: Option<PathBuf>,
    handle: Option<Root>,
}

impl FileRoot {
    pub fn new(root: Option<&Path>) -> Self {
        let resolved = root.and_then(|r| std::fs::canonicalize(r).ok());
        let handle = resolved.as_deref().and_then(|r| Root::pin(r).ok());
        Self {
            named: root.map(Path::to_path_buf),
            resolved,
            handle,
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
                Component::Normal(name) if plain_name(name) => Some(name),
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
        let (resolved, names) = self.names(path)?;
        let root = self
            .handle
            .as_ref()
            .ok_or_else(|| unreadable("The image process could not open its root."))?;
        let file = root.open(resolved, &names)?;
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

/// One name to open inside a directory: not empty, not `.` or `..`, and with no `/`, `\`, `:`
/// (a drive prefix, or an NTFS alternate data stream) or NUL in it, on every OS. A name like
/// `D:photo.png` is a single component to the path parser, but on Windows it names another
/// drive; refused here, it never reaches an open.
pub(crate) fn plain_name(name: &std::ffi::OsStr) -> bool {
    let bytes = name.as_encoded_bytes();
    !bytes.is_empty()
        && bytes != b"."
        && bytes != b".."
        && !bytes.iter().any(|b| matches!(b, b'/' | b'\\' | b':' | 0))
}

/// The root directory's handle, held for the process's life.
#[cfg(unix)]
struct Root(std::os::fd::OwnedFd);

#[cfg(unix)]
#[allow(unsafe_code)]
impl Root {
    fn pin(path: &Path) -> std::io::Result<Self> {
        use std::os::fd::{FromRawFd, OwnedFd};
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::other("NUL in the root"))?;
        // SAFETY: a valid NUL-terminated path; the result is checked before it is owned.
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: `fd` was just opened and is owned by nothing else.
        Ok(Self(unsafe { OwnedFd::from_raw_fd(fd) }))
    }

    /// `names…` under the root, each directory opened from the last one's handle (`openat`),
    /// never following a link.
    fn open(&self, _resolved: &Path, names: &[&std::ffi::OsStr]) -> Result<std::fs::File, Failed> {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        use std::os::unix::ffi::OsStrExt;
        let c =
            |bytes: &[u8]| CString::new(bytes).map_err(|_| unreadable("The image path has a NUL."));
        let failed = |what: &str| {
            let e = std::io::Error::last_os_error();
            unreadable(format!(
                "The image file could not be opened ({what}): {}.",
                e.kind()
            ))
        };
        let (last, dirs) = names
            .split_last()
            .ok_or_else(|| unreadable("The image path names no file."))?;
        let mut held: Option<OwnedFd> = None;
        for name in dirs {
            let name = c(name.as_bytes())?;
            let parent = held.as_ref().map_or(self.0.as_raw_fd(), AsRawFd::as_raw_fd);
            // SAFETY: `parent` is an open directory and `name` a valid NUL-terminated name.
            let fd = unsafe {
                libc::openat(
                    parent,
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(failed("a folder on its path"));
            }
            // SAFETY: as above.
            held = Some(unsafe { OwnedFd::from_raw_fd(fd) });
        }
        let parent = held.as_ref().map_or(self.0.as_raw_fd(), AsRawFd::as_raw_fd);
        let name = c(last.as_bytes())?;
        // SAFETY: as above. O_NONBLOCK: opening a FIFO returns at once instead of waiting.
        let fd = unsafe {
            libc::openat(
                parent,
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
}

/// Windows: every name is opened relative to its parent directory's handle (`NtCreateFile` with
/// `RootDirectory`), starting from the root's handle pinned at start, never by a path built from
/// strings. Each open neither follows a reparse point (`FILE_OPEN_REPARSE_POINT`) nor lets the
/// entry be renamed or deleted while it is held (no delete sharing), and each opened handle is
/// checked not to be a reparse point and to be the kind of entry expected. Names reach this only
/// through [`plain_name`].
#[cfg(windows)]
struct Root(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
#[allow(unsafe_code)]
mod nt {
    use std::ffi::c_void;
    use std::os::windows::io::RawHandle;

    #[repr(C)]
    pub struct UnicodeString {
        pub length: u16,
        pub maximum_length: u16,
        pub buffer: *const u16,
    }

    #[repr(C)]
    pub struct ObjectAttributes {
        pub length: u32,
        pub root_directory: RawHandle,
        pub object_name: *const UnicodeString,
        pub attributes: u32,
        pub security_descriptor: *const c_void,
        pub security_quality_of_service: *const c_void,
    }

    #[repr(C)]
    pub struct IoStatusBlock {
        pub status: isize,
        pub information: usize,
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        pub fn NtCreateFile(
            handle: *mut RawHandle,
            desired_access: u32,
            object_attributes: *const ObjectAttributes,
            io_status: *mut IoStatusBlock,
            allocation_size: *const i64,
            file_attributes: u32,
            share_access: u32,
            create_disposition: u32,
            create_options: u32,
            ea_buffer: *const c_void,
            ea_length: u32,
        ) -> i32;
    }

    pub const OBJ_CASE_INSENSITIVE: u32 = 0x40;
    pub const FILE_LIST_DIRECTORY: u32 = 0x1;
    pub const FILE_READ_DATA: u32 = 0x1;
    pub const FILE_TRAVERSE: u32 = 0x20;
    pub const FILE_READ_ATTRIBUTES: u32 = 0x80;
    pub const SYNCHRONIZE: u32 = 0x0010_0000;
    pub const FILE_SHARE_READ: u32 = 0x1;
    pub const FILE_SHARE_WRITE: u32 = 0x2;
    pub const FILE_OPEN: u32 = 0x1;
    pub const FILE_DIRECTORY_FILE: u32 = 0x1;
    pub const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
    pub const FILE_NON_DIRECTORY_FILE: u32 = 0x40;
    pub const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    pub const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
}

#[cfg(windows)]
#[allow(unsafe_code)]
impl Root {
    /// `name` (one plain name) inside the directory `parent`, as a directory or a file.
    fn child(
        parent: std::os::windows::io::BorrowedHandle<'_>,
        name: &std::ffi::OsStr,
        directory: bool,
    ) -> std::io::Result<std::fs::File> {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        let wide: Vec<u16> = name.encode_wide().collect();
        let bytes =
            u16::try_from(wide.len() * 2).map_err(|_| std::io::Error::other("long name"))?;
        let object_name = nt::UnicodeString {
            length: bytes,
            maximum_length: bytes,
            buffer: wide.as_ptr(),
        };
        let attributes = nt::ObjectAttributes {
            length: std::mem::size_of::<nt::ObjectAttributes>() as u32,
            root_directory: parent.as_raw_handle(),
            object_name: &object_name,
            attributes: nt::OBJ_CASE_INSENSITIVE,
            security_descriptor: std::ptr::null(),
            security_quality_of_service: std::ptr::null(),
        };
        let (access, kind) = if directory {
            (
                nt::FILE_LIST_DIRECTORY | nt::FILE_TRAVERSE,
                nt::FILE_DIRECTORY_FILE,
            )
        } else {
            (nt::FILE_READ_DATA, nt::FILE_NON_DIRECTORY_FILE)
        };
        let mut handle: std::os::windows::io::RawHandle = std::ptr::null_mut();
        let mut io = nt::IoStatusBlock {
            status: 0,
            information: 0,
        };
        // SAFETY: every pointer is to a live, correctly laid out local; `wide` outlives the
        // call; the handle written is checked before it is owned.
        let status = unsafe {
            nt::NtCreateFile(
                &mut handle,
                access | nt::FILE_READ_ATTRIBUTES | nt::SYNCHRONIZE,
                &attributes,
                &mut io,
                std::ptr::null(),
                0,
                nt::FILE_SHARE_READ | nt::FILE_SHARE_WRITE,
                nt::FILE_OPEN,
                kind | nt::FILE_SYNCHRONOUS_IO_NONALERT | nt::FILE_OPEN_REPARSE_POINT,
                std::ptr::null(),
                0,
            )
        };
        if status < 0 || handle.is_null() {
            return Err(std::io::Error::other(format!("NTSTATUS {status:#x}")));
        }
        // SAFETY: NtCreateFile succeeded and gave this handle to nothing else.
        let file = std::fs::File::from(unsafe { OwnedHandle::from_raw_handle(handle) });
        let meta = file.metadata()?;
        if meta.file_attributes() & nt::FILE_ATTRIBUTE_REPARSE_POINT != 0
            || meta.is_dir() != directory
        {
            return Err(std::io::Error::other("a link or the wrong kind of entry"));
        }
        Ok(file)
    }

    /// The root, opened by its path once, at start: held without delete sharing and checked
    /// not to be a reparse point.
    fn pin(path: &Path) -> std::io::Result<Self> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        let root = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(nt::FILE_SHARE_READ | nt::FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let meta = root.metadata()?;
        if meta.file_attributes() & nt::FILE_ATTRIBUTE_REPARSE_POINT != 0 || !meta.is_dir() {
            return Err(std::io::Error::other("the root is a link or not a folder"));
        }
        Ok(Self(root.into()))
    }

    fn open(&self, _resolved: &Path, names: &[&std::ffi::OsStr]) -> Result<std::fs::File, Failed> {
        use std::os::windows::io::AsHandle;
        let (last, dirs) = names
            .split_last()
            .ok_or_else(|| unreadable("The image path names no file."))?;
        // Each folder is held until the next is open beneath it.
        let mut parent: Option<std::fs::File> = None;
        for name in dirs {
            let handle = parent
                .as_ref()
                .map_or(self.0.as_handle(), |p| p.as_handle());
            let next = Self::child(handle, name, true).map_err(|e| {
                unreadable(format!("A folder on the image path can't be used: {e}."))
            })?;
            parent = Some(next);
        }
        let handle = parent
            .as_ref()
            .map_or(self.0.as_handle(), |p| p.as_handle());
        Self::child(handle, last, false)
            .map_err(|e| unreadable(format!("The image file can't be used: {e}.")))
    }
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

    #[test]
    fn the_root_is_the_directory_named_at_start_even_if_its_name_is_reused() -> std::io::Result<()>
    {
        let base = std::env::temp_dir().join(format!("ace-media-pinned-{}", std::process::id()));
        let root = base.join("root");
        std::fs::create_dir_all(&root)?;
        std::fs::write(root.join("a"), b"first")?;
        let files = FileRoot::new(Some(&root));
        // The directory is moved away and another put in its place: reads stay in the first.
        std::fs::rename(&root, base.join("moved"))?;
        std::fs::create_dir_all(&root)?;
        std::fs::write(root.join("a"), b"second")?;
        assert_eq!(
            files
                .read_all(&[input(&root.join("a"), 64)], &|| false)
                .ok(),
            Some(vec![b"first".to_vec()])
        );
        std::fs::remove_dir_all(&base)
    }
}

#[cfg(test)]
mod name_tests {
    use super::plain_name;
    use std::ffi::OsStr;

    #[test]
    fn only_a_plain_single_name_may_be_walked() {
        for bad in [
            "D:photo.png",
            "x:$DATA",
            "blob:stream",
            "a\\b",
            "a/b",
            "..",
            ".",
            "",
            "nul\0byte",
        ] {
            assert!(
                !plain_name(OsStr::new(bad)),
                "{bad:?} was taken as a plain name"
            );
        }
        for good in ["blob", "ab12.png", "attachment-3f.jpg", ".hidden", "a..b"] {
            assert!(plain_name(OsStr::new(good)), "{good:?} was refused");
        }
    }
}
