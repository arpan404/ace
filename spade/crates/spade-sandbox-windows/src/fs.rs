//! File system objects opened as themselves: a reparse point (a symbolic link or a junction) is
//! opened as the link, never followed, and a child is opened relative to its opened folder, so
//! nothing can be swapped in between a check and a change.

use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;

use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows::Wdk::Storage::FileSystem::{
    FILE_OPEN, FILE_OPEN_FOR_BACKUP_INTENT, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
    NtCreateFile,
};
use windows::Win32::Foundation::{
    ERROR_NO_MORE_FILES, HANDLE, RtlNtStatusToDosError, UNICODE_STRING,
};
use windows::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_FLAGS_AND_ATTRIBUTES, FILE_FULL_DIR_INFO, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FileFullDirectoryInfo,
    FileFullDirectoryRestartInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
    OPEN_EXISTING, READ_CONTROL, SYNCHRONIZE, WRITE_DAC,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;
use windows::core::PWSTR;

/// What an opened object is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Info {
    pub dir: bool,
    /// A symbolic link, junction or other reparse point, opened as itself.
    pub reparse: bool,
    /// The volume and the file's index on it: the same for every hard link to one file.
    pub id: (u64, u64),
    pub links: u32,
}

/// An object opened to read and change its DACL, and to list it when it is a folder.
pub struct Object(OwnedHandle);

/// Full access on the object whose ACL we edit: read and change the DACL, read attributes, list.
const ACCESS: u32 =
    READ_CONTROL.0 | WRITE_DAC.0 | FILE_READ_ATTRIBUTES.0 | FILE_LIST_DIRECTORY.0 | SYNCHRONIZE.0;

/// Just enough to open an ancestor and open a child through it: traverse and read attributes (to
/// check for a reparse point). No `WRITE_DAC`, which a standard user does not have on `C:\` and the
/// other folders on the way to the target — asking for it there would fail the whole walk.
const TRAVERSE: u32 = FILE_TRAVERSE.0 | FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0;

impl Object {
    /// Opens `path` by walking it one component at a time, each opened relative to its parent's
    /// pinned directory handle and refused if it is a reparse point (a symbolic link or junction).
    /// So the object returned is exactly the one the person approved: no component of the path can
    /// be swapped for a link that redirects the ACE somewhere else. Intermediate components are
    /// never traversed through a link, unlike [`Object::open`], which protects only the last one.
    pub fn open_pinned(path: &Path) -> std::io::Result<Self> {
        let (root, components) = pinned_parts(path)?;
        let mut object = Self::open_root(&root, TRAVERSE)?;
        if object.info()?.reparse {
            return Err(reparse_refused());
        }
        let last = components.len().saturating_sub(1);
        for (index, name) in components.iter().enumerate() {
            // Ancestors are opened only to traverse; the target gets the ACL rights.
            let access = if index == last { ACCESS } else { TRAVERSE };
            object = object.child(name, access)?;
            if object.info()?.reparse {
                return Err(reparse_refused());
            }
        }
        Ok(object)
    }

    /// Whether `candidate` is `root` or inside it, **proven by file identity, not by string
    /// prefix**: `root`'s `(volume, file id)` is read, and *every* component of `candidate` is
    /// walked pinned to the end, each opened relative to its parent and refused if it is a reparse
    /// point. The answer is yes only if some component matches `root`'s identity *and* the whole of
    /// `candidate` exists and is reparse-free. So a toolchain on another drive, behind a junction,
    /// or a required place that is missing (a deeper component that can't be opened) is never
    /// mistaken for being inside `root` — the walk reaches the missing component and fails. Both
    /// walks use traverse/read-attributes access only, never `WRITE_DAC` (which a standard user
    /// lacks on system roots like `C:\Windows`), because this only reads identity, never edits ACLs.
    pub fn within(root: &Path, candidate: &Path) -> std::io::Result<bool> {
        let root_id = Self::pinned_readonly(root)?.info()?.id;
        let (volume, components) = pinned_parts(candidate)?;
        let mut object = Self::open_root(&volume, TRAVERSE)?;
        let info = object.info()?;
        if info.reparse {
            return Err(reparse_refused());
        }
        let mut matched = info.id == root_id;
        for name in &components {
            object = object.child(name, TRAVERSE)?;
            let info = object.info()?;
            if info.reparse {
                return Err(reparse_refused());
            }
            matched |= info.id == root_id;
        }
        Ok(matched)
    }

    /// Opens `path` by walking it one component at a time, each pinned to its parent and refused if
    /// it is a reparse point, using traverse/read-attributes access throughout (never `WRITE_DAC`).
    /// Used to read a path's identity without the rights an ACL change needs, so it works for a
    /// standard user on a system root. Unlike [`Self::open_pinned`], the final object is opened
    /// read-only, not with ACL-editing rights.
    fn pinned_readonly(path: &Path) -> std::io::Result<Self> {
        let (volume, components) = pinned_parts(path)?;
        let mut object = Self::open_root(&volume, TRAVERSE)?;
        if object.info()?.reparse {
            return Err(reparse_refused());
        }
        for name in &components {
            object = object.child(name, TRAVERSE)?;
            if object.info()?.reparse {
                return Err(reparse_refused());
            }
        }
        Ok(object)
    }

    /// Opens the object with volume serial and file id `(volume, file_id)`, using `on_drive`
    /// (any path on that volume) to reach the volume. The object is found by its id even if it was
    /// renamed or moved since it was granted, so a revocation reaches the right object. The caller
    /// checks the volume serial matches.
    pub fn open_by_id(on_drive: &Path, file_id: u64) -> std::io::Result<Self> {
        use windows::Win32::Storage::FileSystem::{
            FILE_ID_DESCRIPTOR, FILE_ID_DESCRIPTOR_0, FileIdType, OpenFileById,
        };

        let (root, _) = pinned_parts(on_drive)?;
        // The volume is only a hint for OpenFileById; traverse access is enough to open it.
        let volume = Self::open_root(&root, TRAVERSE)?;
        let descriptor = FILE_ID_DESCRIPTOR {
            dwSize: std::mem::size_of::<FILE_ID_DESCRIPTOR>() as u32,
            Type: FileIdType,
            Anonymous: FILE_ID_DESCRIPTOR_0 {
                FileId: file_id as i64,
            },
        };
        // SAFETY: `descriptor` is a live local; `volume` is a handle on the right volume. The
        // returned handle is checked and owned below.
        let handle = unsafe {
            OpenFileById(
                volume.raw(),
                &descriptor,
                ACCESS,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            )
        }
        .map_err(crate::io)?;
        // SAFETY: a fresh handle this object now owns alone.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle.0) }))
    }

    /// Opens a volume root such as `\\?\C:\` as a directory handle to walk from, with `access`.
    fn open_root(root: &OsStr, access: u32) -> std::io::Result<Self> {
        let name = crate::wide(root);
        // SAFETY: `name` is NUL-terminated and outlives the call; the handle is owned below.
        let handle = unsafe {
            CreateFileW(
                windows::core::PCWSTR(name.as_ptr()),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                None,
            )
        }
        .map_err(crate::io)?;
        // SAFETY: a fresh handle this object now owns alone.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle.0) }))
    }

    /// Opens `path` itself (a link as the link).
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let name = crate::wide(path.as_os_str());
        // SAFETY: `name` is NUL-terminated and outlives the call; the handle is owned below.
        let handle = unsafe {
            CreateFileW(
                windows::core::PCWSTR(name.as_ptr()),
                ACCESS,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                None,
            )
        }
        .map_err(crate::io)?;
        // SAFETY: a fresh handle this object now owns alone.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle.0) }))
    }

    /// Opens `name` inside this folder, as itself, with `access`.
    pub fn child(&self, name: &OsStr, access: u32) -> std::io::Result<Self> {
        let mut wide: Vec<u16> = crate::wide(name);
        wide.pop();
        let bytes = u16::try_from(wide.len() * 2)
            .map_err(|_| std::io::Error::other("a name too long to open"))?;
        let text = UNICODE_STRING {
            Length: bytes,
            MaximumLength: bytes,
            Buffer: PWSTR(wide.as_mut_ptr()),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: self.raw(),
            ObjectName: &text,
            ..Default::default()
        };
        let mut handle = HANDLE::default();
        let mut status = IO_STATUS_BLOCK::default();
        // SAFETY: every pointer is to a live local; `name` is relative to our open folder
        // handle; the handle is owned below.
        let result = unsafe {
            NtCreateFile(
                &mut handle,
                windows::Win32::Storage::FileSystem::FILE_ACCESS_RIGHTS(access),
                &attributes,
                &mut status,
                None,
                FILE_FLAGS_AND_ATTRIBUTES(0),
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_OPEN,
                FILE_OPEN_REPARSE_POINT
                    | FILE_OPEN_FOR_BACKUP_INTENT
                    | FILE_SYNCHRONOUS_IO_NONALERT,
                None,
                0,
            )
        };
        if result.is_err() {
            // SAFETY: converts a status code; no memory is touched.
            let code = unsafe { RtlNtStatusToDosError(result) };
            return Err(std::io::Error::from_raw_os_error(code as i32));
        }
        // SAFETY: a fresh handle this object now owns alone.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle.0) }))
    }

    pub fn info(&self) -> std::io::Result<Info> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: `info` is a live local the call fills.
        unsafe { GetFileInformationByHandle(self.raw(), &mut info) }.map_err(crate::io)?;
        Ok(Info {
            dir: info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
            reparse: info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0,
            id: (
                u64::from(info.dwVolumeSerialNumber),
                (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            ),
            links: info.nNumberOfLinks,
        })
    }

    /// The names in this folder, without `.` and `..`.
    pub fn names(&self) -> std::io::Result<Vec<OsString>> {
        // u64 words keep each entry aligned as the kernel writes it.
        let mut buffer = vec![0u64; 8 * 1024];
        let mut names = Vec::new();
        let mut class = FileFullDirectoryRestartInfo;
        loop {
            // SAFETY: the buffer is live and its size in bytes is what we pass.
            let listed = unsafe {
                GetFileInformationByHandleEx(
                    self.raw(),
                    class,
                    buffer.as_mut_ptr().cast(),
                    (buffer.len() * 8) as u32,
                )
            };
            class = FileFullDirectoryInfo;
            if let Err(error) = listed {
                if error.code() == ERROR_NO_MORE_FILES.to_hresult() {
                    return Ok(names);
                }
                return Err(crate::io(error));
            }
            let base = buffer.as_ptr().cast::<u8>();
            let mut offset = 0usize;
            loop {
                // SAFETY: the kernel wrote a chain of entries from the buffer's start, each at
                // `offset`, inside the buffer; read without assuming alignment.
                let entry: FILE_FULL_DIR_INFO =
                    unsafe { std::ptr::read_unaligned(base.add(offset).cast()) };
                let name_at = offset + std::mem::offset_of!(FILE_FULL_DIR_INFO, FileName);
                let units = entry.FileNameLength as usize / 2;
                if name_at + units * 2 > buffer.len() * 8 {
                    return Err(std::io::Error::other(
                        "a folder listing ran past its buffer",
                    ));
                }
                // SAFETY: bounds checked just above; u16 reads may be unaligned only by the
                // entry's own layout, which keeps names 2-byte aligned.
                let name =
                    unsafe { std::slice::from_raw_parts(base.add(name_at).cast::<u16>(), units) };
                let name = OsString::from_wide(name);
                if name != "." && name != ".." {
                    names.push(name);
                }
                if entry.NextEntryOffset == 0 {
                    break;
                }
                offset += entry.NextEntryOffset as usize;
            }
        }
    }

    pub(crate) fn raw(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }
}

fn reparse_refused() -> std::io::Error {
    std::io::Error::other("a reparse point in the path is not allowed")
}

/// Splits an absolute, drive-rooted path into its volume root (`\\?\C:\`) and the `Normal`
/// components to walk. A path that isn't a plain drive-absolute path (a UNC share, a relative or
/// `..`-bearing path, a device name) is refused, since the sandbox only grants real local folders.
fn pinned_parts(path: &Path) -> std::io::Result<(OsString, Vec<OsString>)> {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter,
            _ => {
                return Err(std::io::Error::other(
                    "only a local drive path can be pinned",
                ));
            }
        },
        _ => return Err(std::io::Error::other("the path is not drive-absolute")),
    };
    if !matches!(components.next(), Some(Component::RootDir)) {
        return Err(std::io::Error::other("the path is not drive-absolute"));
    }
    let root = OsString::from(format!(r"\\?\{}:\", (drive as char).to_ascii_uppercase()));
    let mut names = Vec::new();
    for component in components {
        match component {
            Component::Normal(name) => names.push(name.to_owned()),
            // A real policy path has no `.` or `..`; refuse rather than guess.
            _ => return Err(std::io::Error::other("the path has a non-normal component")),
        }
    }
    Ok((root, names))
}
