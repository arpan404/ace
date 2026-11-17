// SPDX-License-Identifier: Apache-2.0

//! The OS backend, plus the polling one used when the OS cannot watch the root.

#[cfg(not(target_os = "linux"))]
use files_safe::Root;
use notify::PollWatcher;
#[cfg(not(target_os = "linux"))]
use notify::Watcher as NotifyWatcher;

use crate::batch::Change;
use crate::observed::Flavour;
#[cfg(not(target_os = "linux"))]
use crate::{
    error::Error,
    exclude::Excluder,
    watch::{Events, no_backend},
};

#[cfg(target_os = "linux")]
pub(crate) use crate::linux::Folders as Native;

/// One recursive OS watch, or one watch per folder on Linux.
pub(crate) enum Backend {
    Native(Native),
    Polling(PollWatcher),
}

impl Backend {
    /// How far this backend's event kinds can be trusted.
    pub(crate) fn flavour(&self) -> Flavour {
        match self {
            Backend::Native(native) => native.flavour(),
            Backend::Polling(_) => Flavour::Exact,
        }
    }

    /// Adds watches for folders that just appeared. Linux only; other backends watch
    /// recursively and return no message.
    pub(crate) fn adopt(&mut self, changes: &mut Vec<Change>) -> Option<String> {
        match self {
            Backend::Native(native) => native.adopt(changes),
            Backend::Polling(_) => None,
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

/// One recursive OS watch: FSEvents on macOS, ReadDirectoryChangesW on Windows.
#[cfg(not(target_os = "linux"))]
pub(crate) struct Native {
    watcher: notify::RecommendedWatcher,
}

#[cfg(not(target_os = "linux"))]
impl Native {
    pub(crate) fn start(
        root: &Root,
        _excluder: &Excluder,
        events: Events,
    ) -> Result<Native, Error> {
        let mut watcher = notify::RecommendedWatcher::new(events, notify::Config::default())
            .map_err(no_backend)?;
        watcher
            .watch(root.path(), notify::RecursiveMode::Recursive)
            .map_err(no_backend)?;
        Ok(Native { watcher })
    }

    pub(crate) fn flavour(&self) -> Flavour {
        Flavour::native()
    }

    pub(crate) fn adopt(&mut self, _changes: &mut Vec<Change>) -> Option<String> {
        None
    }

    pub(crate) fn stop(self) {
        drop(self.watcher);
    }
}
