// SPDX-License-Identifier: Apache-2.0
//! Held directories: the Windows lease that keeps a folder in place while Git
//! runs in it (`packages/git/src/directory-lease.ts`).
//!
//! Windows has no `fchdir`: a new process opens its working directory by path.
//! Git runs in the held directory's canonical path while a lease keeps that
//! object in place: the same object reopened by file ID with no delete
//! sharing, a plain directory (never a junction), its `.git` entry pinned, and
//! the path checked to open the held object before and after Git runs.
//!
//! The platform calls are the injected `DirectoryLeaseApi` (bun:ffi on
//! Windows); this module is the decision logic only. Until the supervisor
//! spawns Git by descriptor, a `directoryFd` call stays on the TypeScript path
//! (porting-guide rule 5), so nothing here opens a descriptor by itself.

use crate::core::error::{GitError, GitErrorCode};

/// Raw handles are pointer-sized integers; `-1` and `0` are invalid.
pub type Handle = i64;

pub const FILE_LIST_DIRECTORY: u32 = 0x1;
pub const FILE_READ_ATTRIBUTES: u32 = 0x80;
pub const SYNCHRONIZE: u32 = 0x100_000;
pub const FILE_SHARE_READ_WRITE: u32 = 0x3;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const NAME_SURROGATE: u32 = 0x2000_0000;

/// The raw Win32 surface (`DirectoryLeaseApi`).
pub trait DirectoryLeaseApi {
    fn os_handle(&self, fd: i32) -> Handle;
    fn file_id(&self, handle: Handle) -> Option<[u8; 24]>;
    fn attributes(&self, handle: Handle) -> Option<(u32, u32)>;
    fn open_by_id(&self, hint: Handle, descriptor: &[u8], access: u32, share: u32) -> Handle;
    fn open_path(&self, path: &str, access: u32, share: u32) -> Handle;
    fn open_target(&self, path: &str) -> Handle;
    fn make_directory(&self, path: &str) -> bool;
    fn final_path(&self, handle: Handle) -> Option<String>;
    fn close(&self, handle: Handle);
}

/// A write may create the `.git` entry it pins when the folder has none yet.
#[derive(Debug, Clone, Copy, Default)]
pub struct LeaseOptions {
    pub create_git_entry: bool,
}

/// The held directory: its canonical path for the child's working directory.
#[derive(Debug)]
pub struct DirectoryLease {
    pub cwd: String,
    handles: Vec<Handle>,
    released: bool,
}

fn invalid(handle: Handle) -> bool {
    handle <= 0
}

fn changed(reason: &str) -> GitError {
    GitError::new(
        GitErrorCode::FilesystemError,
        format!("The project folder changed: {reason}"),
    )
}

fn unsupported() -> GitError {
    GitError::new(
        GitErrorCode::UnsupportedRepository,
        "Git can't run in this network folder on Windows: it can't be held in place. Use a local folder.",
    )
}

fn plain_directory(api: &dyn DirectoryLeaseApi, handle: Handle) -> Result<(), GitError> {
    let Some((attributes, tag)) = api.attributes(handle) else {
        return Err(changed("it is unreadable"));
    };
    if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(changed("it is not a folder"));
    }
    // Junctions and symlinks name another place; cloud and dedup tags keep the folder itself.
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 && tag & NAME_SURROGATE != 0 {
        return Err(changed("it is now a link"));
    }
    Ok(())
}

/// `C:\...` or `\\server\share\...`, never a verbatim path.
fn working_path(api: &dyn DirectoryLeaseApi, handle: Handle) -> Result<String, GitError> {
    let Some(path) = api.final_path(handle) else {
        return Err(changed("it has no path"));
    };
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        if rest.len() > 2 && rest.as_bytes()[1] == b':' && rest.as_bytes()[2] == b'\\' {
            return Ok(rest.to_owned());
        }
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return Ok(format!(r"\\{unc}"));
        }
    }
    if path.starts_with(r"\\") || (path.len() > 2 && path.as_bytes()[1] == b':') {
        return Ok(path);
    }
    Err(changed("it has no drive path"))
}

/// `path`, followed as a new process would, must open the object `expected` identifies.
fn leads_to(api: &dyn DirectoryLeaseApi, path: &str, expected: &[u8; 24]) -> Result<(), GitError> {
    let target = api.open_target(path);
    if invalid(target) {
        return Err(changed("its path no longer opens it"));
    }
    let same = api.file_id(target).is_some_and(|id| &id == expected);
    api.close(target);
    if !same {
        return Err(changed("its path leads elsewhere"));
    }
    Ok(())
}

/// Pins `<cwd>\.git`, creating it first when allowed and absent; it must be this folder's own.
fn pin_git_entry(
    api: &dyn DirectoryLeaseApi,
    cwd: &str,
    create: bool,
) -> Result<Option<Handle>, GitError> {
    let name = format!(r"{cwd}\.git");
    let access = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    let mut entry = api.open_path(&name, access, FILE_SHARE_READ_WRITE);
    if invalid(entry) && create {
        api.make_directory(&name);
        entry = api.open_path(&name, access, FILE_SHARE_READ_WRITE);
        if invalid(entry) {
            return Err(changed("its .git entry could not be created"));
        }
    }
    if invalid(entry) {
        return Ok(None);
    }
    // Opened by path: it must still be this directory's own entry, not one behind a new link.
    let pinned = working_path(api, entry);
    match pinned {
        Ok(pinned) if pinned.eq_ignore_ascii_case(&name) => Ok(Some(entry)),
        Ok(_) => {
            api.close(entry);
            Err(changed("it moved"))
        }
        Err(error) => {
            api.close(entry);
            Err(error)
        }
    }
}

/// Leases the directory behind a held descriptor for one Git process.
pub fn lease_held_directory(
    api: &dyn DirectoryLeaseApi,
    fd: i32,
    options: LeaseOptions,
) -> Result<DirectoryLease, GitError> {
    let mut handles: Vec<Handle> = Vec::new();
    let held = api.os_handle(fd);
    if invalid(held) {
        return Err(changed("its descriptor is closed"));
    }
    let network = working_path(api, held)?.starts_with(r"\\");
    let Some(expected) = api.file_id(held) else {
        return Err(if network {
            unsupported()
        } else {
            changed("its identity is unreadable")
        });
    };
    // FILE_ID_DESCRIPTOR: size, type, then the 16-byte extended file ID.
    let mut descriptor = [0u8; 24];
    descriptor[0..4].copy_from_slice(&24u32.to_le_bytes());
    descriptor[4..8].copy_from_slice(&2u32.to_le_bytes());
    descriptor[8..24].copy_from_slice(&expected[8..24]);
    let access = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    let lease = api.open_by_id(held, &descriptor, access, FILE_SHARE_READ_WRITE);
    if invalid(lease) {
        return Err(if network {
            unsupported()
        } else {
            changed("it is being renamed or deleted")
        });
    }
    handles.push(lease);
    let outcome = (|| {
        let same = api.file_id(lease).is_some_and(|id| id == expected);
        if !same {
            return Err(changed("it was replaced"));
        }
        plain_directory(api, lease)?;
        let cwd = working_path(api, lease)?;
        if let Some(entry) = pin_git_entry(api, &cwd, options.create_git_entry)? {
            handles.push(entry);
        }
        plain_directory(api, lease)?;
        leads_to(api, &cwd, &expected)?;
        Ok(cwd)
    })();
    match outcome {
        Ok(cwd) => Ok(DirectoryLease {
            cwd,
            handles,
            released: false,
        }),
        Err(error) => {
            for handle in handles {
                api.close(handle);
            }
            Err(error)
        }
    }
}

impl DirectoryLease {
    /// Confirms the held directory is still a plain directory its path leads to.
    pub fn verify(&self, api: &dyn DirectoryLeaseApi) -> Result<(), GitError> {
        if self.released {
            return Err(changed("its lease ended"));
        }
        let Some(lease) = self.handles.first().copied() else {
            return Err(changed("its lease ended"));
        };
        plain_directory(api, lease)?;
        let expected = api
            .file_id(lease)
            .ok_or_else(|| changed("its identity is unreadable"))?;
        leads_to(api, &self.cwd, &expected)
    }

    pub fn release(&mut self, api: &dyn DirectoryLeaseApi) {
        if self.released {
            return;
        }
        self.released = true;
        for handle in self.handles.drain(..) {
            api.close(handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// A fake Win32 surface: handles keyed by id, paths leading where the test says.
    struct Fake {
        handles: RefCell<HashMap<Handle, [u8; 24]>>,
        next: RefCell<Handle>,
        paths: RefCell<HashMap<String, Handle>>,
        final_paths: RefCell<HashMap<Handle, String>>,
        created: RefCell<Vec<String>>,
        os_handle: Handle,
        reparse: bool,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                handles: RefCell::new(HashMap::new()),
                next: RefCell::new(10),
                paths: RefCell::new(HashMap::new()),
                final_paths: RefCell::new(HashMap::new()),
                created: RefCell::new(Vec::new()),
                os_handle: 1,
                reparse: false,
            }
        }

        fn add(&self, id: [u8; 24], path: &str) -> Handle {
            let mut next = self.next.borrow_mut();
            let handle = *next;
            *next += 1;
            self.handles.borrow_mut().insert(handle, id);
            self.final_paths
                .borrow_mut()
                .insert(handle, path.to_owned());
            self.paths.borrow_mut().insert(path.to_owned(), handle);
            handle
        }
    }

    /// The identity every fake handle carries, held descriptor included.
    fn id() -> [u8; 24] {
        let mut id = [0u8; 24];
        id[8] = 7;
        id
    }

    impl DirectoryLeaseApi for Fake {
        fn os_handle(&self, _fd: i32) -> Handle {
            self.os_handle
        }
        fn file_id(&self, handle: Handle) -> Option<[u8; 24]> {
            self.handles.borrow().get(&handle).copied()
        }
        fn attributes(&self, _handle: Handle) -> Option<(u32, u32)> {
            Some(if self.reparse {
                (
                    FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT,
                    NAME_SURROGATE,
                )
            } else {
                (FILE_ATTRIBUTE_DIRECTORY, 0)
            })
        }
        fn open_by_id(
            &self,
            _hint: Handle,
            _descriptor: &[u8],
            _access: u32,
            _share: u32,
        ) -> Handle {
            self.add(id(), r"C:\work")
        }
        fn open_path(&self, path: &str, _access: u32, _share: u32) -> Handle {
            self.paths.borrow().get(path).copied().unwrap_or(-1)
        }
        fn open_target(&self, path: &str) -> Handle {
            self.open_path(path, 0, 0)
        }
        fn make_directory(&self, path: &str) -> bool {
            self.created.borrow_mut().push(path.to_owned());
            // The created entry is openable by path, as Windows leaves it.
            self.add(id(), path);
            true
        }
        fn final_path(&self, handle: Handle) -> Option<String> {
            self.final_paths.borrow().get(&handle).cloned()
        }
        fn close(&self, _handle: Handle) {}
    }

    #[test]
    fn a_closed_descriptor_is_a_filesystem_error() {
        let mut fake = Fake::new();
        fake.os_handle = -1;
        let error = lease_held_directory(&fake, 3, LeaseOptions::default()).expect_err("closed");
        assert_eq!(error.code, GitErrorCode::FilesystemError);
        assert!(error.message.contains("descriptor is closed"));
    }

    #[test]
    fn a_junction_in_place_of_the_folder_is_refused_as_a_link() {
        let mut fake = Fake::new();
        fake.os_handle = fake.add(id(), r"C:\work");
        fake.reparse = true;
        let error = lease_held_directory(&fake, 3, LeaseOptions::default()).expect_err("linked");
        assert!(error.message.contains("now a link"), "{}", error.message);
    }

    #[test]
    fn a_network_folder_that_cannot_be_held_is_unsupported() {
        let mut fake = Fake::new();
        fake.os_handle = fake.add(id(), r"\\server\share\work");
        // The identity cannot be read: an ordinary folder is a change, a network one is unsupported.
        fake.handles.borrow_mut().clear();
        let error = lease_held_directory(&fake, 3, LeaseOptions::default()).expect_err("network");
        assert_eq!(error.code, GitErrorCode::UnsupportedRepository);
    }

    #[test]
    fn a_write_creates_the_git_entry_it_pins_and_a_plain_folder_verifies() {
        let mut fake = Fake::new();
        fake.os_handle = fake.add(id(), r"C:\work");
        let lease = lease_held_directory(
            &fake,
            3,
            LeaseOptions {
                create_git_entry: true,
            },
        )
        .expect("lease");
        assert_eq!(lease.cwd, r"C:\work");
        assert_eq!(*fake.created.borrow(), vec![r"C:\work\.git".to_owned()]);
        lease.verify(&fake).expect("still the same folder");
    }
}
