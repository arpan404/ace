// SPDX-License-Identifier: Apache-2.0

//! What a folder holds for one name, asked thousands of times in a burst.

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::io;
use std::sync::Arc;

use cap_std::fs::{Dir, Metadata};

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
/// create into one that reads each folder on its first path. The caller decides when a reading is
/// stale by clearing the burst: a file created later in it is still seen, because its presence and
/// kind are read live, and a stored spelling the reading does not know yet is taken as the spelling
/// that was asked for, which is exactly what creating one stores. A folder that is replaced in the
/// middle of a burst is answered from the folder the burst opened; the next burst opens it again.
#[derive(Default)]
pub struct Readings {
    folders: VecDeque<Folder>,
}

struct Folder {
    /// The folder's relative path, which is what a caller names it by.
    path: String,
    /// The folder handle every lookup in it goes through, opened and proven once.
    dir: Dir,
    /// The names the volume stores here, read the first time a volume that folds case asks.
    names: Option<Arc<Listing>>,
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

    /// The folder `path` names, opened and proven if this burst has not asked for it yet.
    fn folder(&mut self, root: &Root, path: &str) -> Result<&mut Folder, Error> {
        match self.folders.iter().position(|held| held.path == path) {
            Some(index) => {
                let Some(held) = self.folders.remove(index) else {
                    return Err(Error::PathChanged(path.to_owned()));
                };
                self.folders.push_front(held);
            }
            None => {
                let dir = walk::open_folder_unstored(root, path)?;
                while self.folders.len() >= KEPT {
                    self.folders.pop_back();
                }
                self.folders.push_front(Folder {
                    path: path.to_owned(),
                    dir,
                    names: None,
                });
            }
        }
        self.folders
            .front_mut()
            .ok_or_else(|| Error::PathChanged(path.to_owned()))
    }
}

impl Folder {
    /// The spelling this folder stores for the entry `metadata` describes, once it is known.
    fn stored(
        &mut self,
        path: &str,
        requested: &OsStr,
        metadata: &Metadata,
    ) -> Result<Option<OsString>, Error> {
        if self.names.is_none() {
            self.names = Some(Arc::new(names::read(&self.dir, path)?));
        }
        Ok(self
            .names
            .as_ref()
            .and_then(|listing| listing.name_of(requested, metadata))
            .map(OsStr::to_os_string))
    }
}

impl Root {
    /// What the volume holds for the last name of `rel`, without following it.
    ///
    /// The folder that holds the name is reached through handles and remembered in `readings`, so a
    /// burst of lookups in one folder walks to it once. Nothing is listed on a volume that keeps
    /// the spelling it is given; on one that folds case the folder's names are read once per
    /// `readings`, because only they can say whether the spelling that was asked for is the one
    /// the volume stores.
    pub fn look(&self, rel: &str, readings: &mut Readings) -> Result<Found, Error> {
        let rel = Root::check(rel)?;
        let (folder, leaf) = walk::split(rel)?;
        let held = readings.folder(self, folder)?;
        let metadata = match held.dir.symlink_metadata(leaf) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Found::Missing),
            Err(error) => return Err(error.into()),
        };
        if self.folds_case()
            && held
                .stored(folder, OsStr::new(leaf), &metadata)?
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
