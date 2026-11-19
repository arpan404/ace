// SPDX-License-Identifier: Apache-2.0

//! The kernel's word that an open folder changed, where the OS watch itself is not prompt.
//!
//! macOS has one, over kqueue, because FSEvents passes through fseventsd. Linux's inotify and
//! Windows' `ReadDirectoryChangesW` already come straight from the kernel, so there the safety
//! net's timer is enough and this is empty.

#[cfg(target_os = "macos")]
pub(crate) use crate::macos::wake::Wake;

#[cfg(not(target_os = "macos"))]
pub(crate) struct Wake;

#[cfg(not(target_os = "macos"))]
impl Wake {
    pub(crate) fn start(_events: crate::watch::Events) -> Option<Wake> {
        None
    }

    pub(crate) fn follow<'a>(
        &mut self,
        _root: &files_safe::Root,
        _folders: impl Iterator<Item = &'a str>,
    ) {
    }

    pub(crate) fn rearm(&mut self, _root: &files_safe::Root, _folder: &str) {}
}
