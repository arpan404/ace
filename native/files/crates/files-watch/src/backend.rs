// SPDX-License-Identifier: Apache-2.0

//! The OS watcher, plus the polling one used when the OS cannot watch the root.
//!
//! Linux watches one folder at a time with inotify so excluded folders never take a watch.
//! Windows has its own `ReadDirectoryChangesW` backend, because `notify` hides the status that
//! says the kernel lost events. Everywhere else `notify` provides the recursive watch.

use std::time::Duration;

use files_safe::Root;
use notify::{PollWatcher, Watcher as NotifyWatcher};

use crate::error::Error;
use crate::exclude::Excluder;
use crate::translate::Notice;
use crate::watch::Events;

#[cfg(target_os = "linux")]
pub(crate) use crate::linux::Folders as Native;
#[cfg(windows)]
pub(crate) use crate::windows::Watch as Native;

fn unsupported(error: notify::Error) -> Error {
    Error::Unsupported(error.to_string())
}

/// How often the polling fallback scans the tree.
pub(crate) const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// One recursive OS watch, or one watch per folder on Linux.
pub(crate) enum Backend {
    Native(Native),
    Polling(PollWatcher),
}

impl Backend {
    /// Adds the watches a folder that just appeared needs; only Linux does anything here.
    pub(crate) fn adopt(
        &mut self,
        root: &Root,
        excluder: &Excluder,
        notices: &mut Vec<Notice>,
    ) -> Result<(), Error> {
        match self {
            Backend::Native(native) => native.adopt(root, excluder, notices),
            Backend::Polling(_) => Ok(()),
        }
    }

    /// Re-adds whatever the kernel lost when it overflowed.
    pub(crate) fn rescan(
        &mut self,
        root: &Root,
        excluder: &Excluder,
        dir: Option<&str>,
    ) -> Result<(), Error> {
        match self {
            Backend::Native(native) => native.rescan(root, excluder, dir),
            Backend::Polling(_) => Ok(()),
        }
    }

    /// Stops OS notifications before the worker drops its sink.
    pub(crate) fn stop(self) {
        match self {
            Backend::Native(native) => native.stop(),
            Backend::Polling(watcher) => drop(watcher),
        }
    }
}

/// The polling fallback: a snapshot every two seconds, never following symbolic links.
pub(crate) fn poll(root: &Root, events: Events) -> Result<PollWatcher, Error> {
    let config = notify::Config::default()
        .with_poll_interval(POLL_INTERVAL)
        .with_follow_symlinks(false);
    let mut watcher = PollWatcher::new(events, config).map_err(unsupported)?;
    watcher
        .watch(root.path(), notify::RecursiveMode::Recursive)
        .map_err(unsupported)?;
    Ok(watcher)
}

/// One recursive OS watch: FSEvents on macOS, kqueue on the BSDs.
#[cfg(all(not(target_os = "linux"), not(windows)))]
pub(crate) struct Native {
    watcher: notify::RecommendedWatcher,
}

#[cfg(all(not(target_os = "linux"), not(windows)))]
impl Native {
    pub(crate) fn start(
        root: &Root,
        _excluder: &Excluder,
        events: Events,
    ) -> Result<Native, Error> {
        let mut watcher = notify::RecommendedWatcher::new(events, notify::Config::default())
            .map_err(unsupported)?;
        watcher
            .watch(root.path(), notify::RecursiveMode::Recursive)
            .map_err(unsupported)?;
        Ok(Native { watcher })
    }

    /// The OS watch is recursive: new folders are already covered.
    pub(crate) fn adopt(
        &mut self,
        _root: &Root,
        _excluder: &Excluder,
        _notices: &mut Vec<Notice>,
    ) -> Result<(), Error> {
        Ok(())
    }

    /// Nothing to rebuild after an overflow: the OS watch is still whole.
    pub(crate) fn rescan(
        &mut self,
        _root: &Root,
        _excluder: &Excluder,
        _dir: Option<&str>,
    ) -> Result<(), Error> {
        Ok(())
    }

    pub(crate) fn stop(self) {
        drop(self.watcher);
    }
}
