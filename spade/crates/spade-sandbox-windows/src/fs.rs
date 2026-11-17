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
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileFullDirectoryInfo,
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

const ACCESS: u32 =
    READ_CONTROL.0 | WRITE_DAC.0 | FILE_READ_ATTRIBUTES.0 | FILE_LIST_DIRECTORY.0 | SYNCHRONIZE.0;

impl Object {
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

    /// Opens `name` inside this folder, as itself.
    pub fn child(&self, name: &OsStr) -> std::io::Result<Self> {
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
                windows::Win32::Storage::FileSystem::FILE_ACCESS_RIGHTS(ACCESS),
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
