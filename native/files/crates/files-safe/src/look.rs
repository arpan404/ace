// SPDX-License-Identifier: Apache-2.0

//! What a folder holds for one name, asked thousands of times in a burst.

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::io;
use std::sync::Arc;

use cap_std::fs::{Dir, Metadata};

use crate::case;
use crate::identity::Identity;
use crate::names::{self, Listing};
use crate::walk;
use crate::{Error, Root};

/// What the volume holds for one name a caller asked about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Found {
    /// Nothing is stored under that name.
    Missing,
    /// The name is there and is a folder.
    Folder,
    /// The name is there and is not a folder.
    Other,
    /// The name is there under another spelling: the volume folded the case of the request. A
    /// caller watching names takes this as the spelling it asked about being gone, so a rename
    /// that only changes case does not leave the old name behind.
    Renamed,
}

/// How many folders one burst keeps open and read. A burst names a handful of folders, and the
/// limit keeps one that names thousands from holding thousands of descriptors.
const KEPT: usize = 16;

/// The folders one burst of lookups has already opened and read.
///
/// A watcher asks about thousands of paths in a burst and they share a few folders. Opening each
/// folder once, and reading the names it stores once, turns a burst that lists a folder for every
/// create into one that reads each folder on its first path. A cached handle is never trusted on
/// its own: every reuse is preceded by one lookup that proves the folder's name still leads to it,
/// and a folder that was moved away or replaced is opened again through the confined walk.
///
/// The caller decides when a reading is stale by clearing the burst, and tells the readings about
/// a rename so the names it read before the rename are not used to judge it.
#[derive(Default)]
pub struct Readings {
    folders: VecDeque<Folder>,
}

struct Folder {
    /// The folder's relative path, which is what a caller names it by.
    path: String,
    /// The folder handle every lookup in it goes through, proven again before each reuse.
    dir: Dir,
    /// What names this folder on its volume, so the handle can be proven with one lookup.
    identity: Option<Identity>,
    /// Whether this folder folds name case, asked when it was opened.
    folds_case: bool,
    /// The names the volume stores here, read the first time a folder that folds case asks.
    names: Option<Arc<Listing>>,
}

impl Folder {
    /// Opens the folder `path` names through the confined walk, and classifies it.
    fn open(root: &Root, path: &str) -> Result<Folder, Error> {
        let dir = walk::open_folder_unstored(root, path)?;
        let identity = root.folder_identity(&dir);
        let folds_case = case::folds(&dir);
        Ok(Folder {
            path: path.to_owned(),
            dir,
            identity,
            folds_case,
            names: None,
        })
    }

    /// Whether the name this handle was opened under still leads to it.
    fn still_names(&self, root: &Root) -> bool {
        root.still_names(&self.path, self.identity)
    }

    /// The spelling this folder stores for the entry `metadata` describes, once it is known.
    fn stored(
        &mut self,
        requested: &OsStr,
        metadata: &Metadata,
    ) -> Result<Option<OsString>, Error> {
        if self.names.is_none() {
            self.names = Some(Arc::new(names::read(&self.dir, &self.path)?));
        }
        Ok(self
            .names
            .as_ref()
            .and_then(|listing| listing.name_of(requested, metadata))
            .map(OsStr::to_os_string))
    }
}

impl Readings {
    /// Readings with no folder in them.
    pub fn new() -> Readings {
        Readings::default()
    }

    /// Forget every folder and reading, so the next lookups see the tree as it is now.
    pub fn clear(&mut self) {
        self.folders.clear();
    }

    /// The names the folder holding `path` stores have changed: forget what was read there, so the
    /// next lookup reads them again.
    ///
    /// A rename is the case that matters. Judging the new spelling against names read before the
    /// rename would find the old spelling under the same identity and call the new one renamed, so
    /// a caller that hears about a rename says so here before either spelling is looked up.
    pub fn renamed(&mut self, path: &str) {
        let folder = path.rsplit_once('/').map_or("", |(folder, _)| folder);
        if let Some(index) = self.folders.iter().position(|held| held.path == folder)
            && let Some(held) = self.folders.get_mut(index)
        {
            held.names = None;
        }
    }

    /// The folder `path` names, opened and proven if this burst has not asked for it yet.
    fn folder(&mut self, root: &Root, path: &str) -> Result<&mut Folder, Error> {
        let index = self.folders.iter().position(|held| held.path == path);
        let reusable = index.is_some_and(|index| {
            self.folders
                .get(index)
                .is_some_and(|held| held.still_names(root))
        });
        if reusable {
            if let Some(index) = index
                && let Some(held) = self.folders.remove(index)
            {
                self.folders.push_front(held);
            }
        } else {
            if let Some(index) = index {
                self.folders.remove(index);
            }
            let held = Folder::open(root, path)?;
            while self.folders.len() >= KEPT {
                self.folders.pop_back();
            }
            self.folders.push_front(held);
        }
        self.folders
            .front_mut()
            .ok_or_else(|| Error::PathChanged(path.to_owned()))
    }
}

impl Root {
    /// What the volume holds for the last name of `rel`, without following it.
    ///
    /// The folder that holds the name is reached through handles and remembered in `readings`, so a
    /// burst of lookups in one folder walks to it once, and each reuse of that handle is proven
    /// against the folder's name first. Nothing is listed on a folder that keeps the spelling it is
    /// given; on one that folds case the folder's names are read once per `readings`, because only
    /// they can say whether the spelling that was asked for is the one the volume stores.
    pub fn look(&self, rel: &str, readings: &mut Readings) -> Result<Found, Error> {
        let rel = Root::check(rel)?;
        let (folder, leaf) = walk::split(rel)?;
        let held = readings.folder(self, folder)?;
        let metadata = match held.dir.symlink_metadata(leaf) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Found::Missing),
            Err(error) => return Err(error.into()),
        };
        if held.folds_case
            && held
                .stored(OsStr::new(leaf), &metadata)?
                .is_some_and(|stored| stored != leaf)
        {
            return Ok(Found::Renamed);
        }
        Ok(if metadata.is_dir() {
            Found::Folder
        } else {
            Found::Other
        })
    }
}
