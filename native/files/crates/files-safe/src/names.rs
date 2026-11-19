// SPDX-License-Identifier: Apache-2.0

//! The spelling a folder stores for a name.
//!
//! One entry can be reached by more than one spelling: case-insensitive volumes, normalizing
//! volumes and 8.3 short names all accept a spelling that is not the one on disk, and a folder can
//! even hold `readme` and `readme ` side by side. So the walk never trusts the spelling it was
//! asked for. For a folder it opened, the operating system reports the path of the handle and the
//! name is taken from there. For an entry it only stat'd, the folder is listed and the entry picked
//! out by identity, never by text; when no entry matches, the folder changed under the walk and
//! that is an error rather than a guessed name.
//!
//! Listings are remembered per root, stamped with the folder's identity and modification time, so
//! resolving every entry of one folder lists it once.

use std::collections::{HashMap, hash_map::Entry};
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use cap_std::fs::{Dir, Metadata};
use cap_std::time::SystemTime;

use crate::error::Error;

/// How many folder listings are remembered. A resolve touches a handful of folders; a listing of a
/// folder with a hundred thousand entries is not something to keep for long.
const FOLDERS: usize = 4;

/// How many entries are remembered across all remembered listings, so a few enormous folders
/// cannot grow the cache without bound.
const ENTRIES: usize = 200_000;

/// What identifies one entry of a folder: the device and inode on Unix, the folded name on
/// Windows. Entries of other folders are never compared against these.
#[cfg(unix)]
type Key = (u64, u64);

#[cfg(not(unix))]
type Key = String;

/// One entry's names. A file with several hard links has one per link, all the same identity, so
/// the walk can still answer with the spelling it was asked for.
enum Names {
    One(OsString),
    More(Vec<OsString>),
}

impl Names {
    fn add(&mut self, name: OsString) {
        match self {
            Names::One(first) => *self = Names::More(vec![first.clone(), name]),
            Names::More(names) => names.push(name),
        }
    }

    /// The name that matches `requested`, exactly if it is there and by case otherwise, so a hard
    /// link answers with its own name rather than a sibling's.
    fn pick(&self, requested: &OsStr) -> Option<&OsStr> {
        let names: &[OsString] = match self {
            Names::One(only) => std::slice::from_ref(only),
            Names::More(names) => names,
        };
        let exact = names.iter().find(|name| name.as_os_str() == requested);
        let folded = names.iter().find(|name| same_name(name, requested));
        exact
            .or(folded)
            .or_else(|| names.first())
            .map(OsString::as_os_str)
    }
}

/// One folder's entries, by identity.
pub(crate) struct Listing {
    entries: HashMap<Key, Names>,
}

impl Listing {
    /// Lists `dir`, keying each entry by `dev` (the folder's device) and the entry's inode.
    fn read(dir: &Dir, dev: u64) -> io::Result<Listing> {
        let mut entries: HashMap<Key, Names> = HashMap::new();
        for entry in dir.entries()? {
            let entry = entry?;
            let name = entry.file_name();
            match entries.entry(entry_key(dev, &entry, &name)) {
                Entry::Vacant(slot) => {
                    slot.insert(Names::One(name));
                }
                Entry::Occupied(mut slot) => slot.get_mut().add(name),
            }
        }
        Ok(Listing { entries })
    }

    fn find(&self, wanted: &Key, requested: &OsStr) -> Option<&OsStr> {
        self.entries.get(wanted)?.pick(requested)
    }

    /// The name this listing stores for the entry `metadata` describes, preferring exactly the
    /// spelling that was asked for.
    ///
    /// `None` means the listing does not know that entry: the folder changed after it was read, or
    /// the entry was created after it. A caller watching a burst sees both, and treats a name it
    /// cannot place as the spelling that was asked for, which is what creating one stores.
    pub(crate) fn name_of(&self, requested: &OsStr, metadata: &Metadata) -> Option<&OsStr> {
        self.find(&wanted_key(requested, metadata), requested)
    }
}

/// Reads the names `dir` stores, for a caller that keeps the reading instead of this cache.
pub(crate) fn read(dir: &Dir, folder: &str) -> Result<Listing, Error> {
    let stamp = stamp(dir, folder)?;
    Listing::read(dir, stamp.dev).map_err(Into::into)
}

/// Whether two names are the same entry on a volume that ignores case.
#[cfg(unix)]
fn same_name(found: &OsStr, requested: &OsStr) -> bool {
    found == requested
}

#[cfg(not(unix))]
fn same_name(found: &OsStr, requested: &OsStr) -> bool {
    folded(found) == folded(requested)
}

/// The identity and modification time a listing is valid for.
#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    folder: String,
    dev: u64,
    ino: u64,
    modified: Option<SystemTime>,
}

/// Remembered folder listings, most recently used last.
#[derive(Default)]
pub(crate) struct Cache {
    rooms: Vec<(Stamp, Arc<Listing>)>,
}

impl Cache {
    fn get(&self, stamp: &Stamp) -> Option<Arc<Listing>> {
        self.rooms
            .iter()
            .find(|(held, _)| held == stamp)
            .map(|(_, listing)| Arc::clone(listing))
    }

    fn put(&mut self, stamp: Stamp, listing: Arc<Listing>) {
        // A listing that alone is over the budget is used for this lookup and then dropped.
        if listing.entries.len() > ENTRIES {
            return;
        }
        self.rooms.push((stamp, listing));
        while self.rooms.len() > FOLDERS || self.held() > ENTRIES {
            self.rooms.remove(0);
        }
    }

    fn held(&self) -> usize {
        self.rooms
            .iter()
            .map(|(_, listing)| listing.entries.len())
            .sum()
    }
}

/// The name `dir` stores for the entry `metadata` describes, which lives in the folder spelled
/// `folder` below the root.
///
/// Fails with `PATH_CHANGED` when the folder no longer holds an entry of that identity, since the
/// listing and the entry were read at different moments.
pub(crate) fn listed(
    cache: &Mutex<Cache>,
    dir: &Dir,
    folder: &str,
    name: &OsStr,
    metadata: &Metadata,
) -> Result<OsString, Error> {
    let stamp = stamp(dir, folder)?;
    let wanted = wanted_key(name, metadata);
    let listing = match held(cache, &stamp) {
        Some(listing) => listing,
        None => {
            let listing = Arc::new(Listing::read(dir, stamp.dev)?);
            remember(cache, stamp, Arc::clone(&listing));
            listing
        }
    };
    listing
        .find(&wanted, name)
        .map(OsStr::to_os_string)
        .ok_or_else(|| changed(folder))
}

/// The name the operating system reports for a folder handle, when it can report one.
///
/// This is the primary source: the kernel hands back the path it walks to, which carries the name
/// the disk stores, without listing the folder at all.
pub(crate) fn from_handle(dir: &Dir) -> Option<OsString> {
    let path = handle_path(dir)?;
    path.file_name().map(OsStr::to_os_string)
}

/// macOS and its siblings answer `F_GETPATH` with the path of the open handle.
#[cfg(target_vendor = "apple")]
fn handle_path(dir: &Dir) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;

    let path = rustix::fs::getpath(dir).ok()?;
    Some(PathBuf::from(OsStr::from_bytes(path.as_bytes())))
}

/// Windows answers with the final path name of the handle.
#[cfg(windows)]
fn handle_path(dir: &Dir) -> Option<PathBuf> {
    let file = dir.try_clone().ok()?.into_std_file();
    winx::file::get_file_path(&file).ok()
}

/// Other platforms have no cheap way to name an open handle, so the listing decides.
#[cfg(not(any(windows, target_vendor = "apple")))]
fn handle_path(_dir: &Dir) -> Option<PathBuf> {
    None
}

/// The stamp of `dir` as it is at this moment.
fn stamp(dir: &Dir, folder: &str) -> Result<Stamp, Error> {
    let metadata = dir.dir_metadata()?;
    let (dev, ino) = folder_identity(&metadata);
    Ok(Stamp {
        folder: folder.to_owned(),
        dev,
        ino,
        modified: metadata.modified().ok(),
    })
}

/// A folder's device and inode, or zeros where the platform does not report them.
#[cfg(unix)]
fn folder_identity(metadata: &Metadata) -> (u64, u64) {
    use cap_std::fs::MetadataExt;

    (metadata.dev(), metadata.ino())
}

#[cfg(not(unix))]
fn folder_identity(_metadata: &Metadata) -> (u64, u64) {
    // The stamp's folder name and modification time still separate one folder from another.
    (0, 0)
}

/// The key a listed entry is stored under.
#[cfg(unix)]
fn entry_key(dev: u64, entry: &cap_std::fs::DirEntry, _name: &OsStr) -> Key {
    use std::os::unix::fs::DirEntryExt;

    (dev, entry.ino())
}

/// Windows does not report a file index through `std` on stable, and does not need one: a folder
/// holds one entry per name, and [`crate::Root::check`] has already refused the 8.3 short names and
/// trailing dots or spaces that would make two names fold together.
#[cfg(not(unix))]
fn entry_key(_dev: u64, _entry: &cap_std::fs::DirEntry, name: &OsStr) -> Key {
    folded(name)
}

/// The key the entry `metadata` describes is stored under.
#[cfg(unix)]
fn wanted_key(_name: &OsStr, metadata: &Metadata) -> Key {
    use cap_std::fs::MetadataExt;

    (metadata.dev(), metadata.ino())
}

#[cfg(not(unix))]
fn wanted_key(name: &OsStr, _metadata: &Metadata) -> Key {
    folded(name)
}

#[cfg(not(unix))]
fn folded(name: &OsStr) -> String {
    name.to_string_lossy().to_lowercase()
}

fn held(cache: &Mutex<Cache>, stamp: &Stamp) -> Option<Arc<Listing>> {
    cache
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .get(stamp)
}

fn remember(cache: &Mutex<Cache>, stamp: Stamp, listing: Arc<Listing>) {
    cache
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .put(stamp, listing);
}

fn changed(folder: &str) -> Error {
    Error::PathChanged(folder.to_owned())
}

/// The handle path is only worth having if it really carries the stored spelling, which is what
/// makes it the primary source on Apple platforms.
#[cfg(all(test, target_vendor = "apple"))]
mod handle_tests {
    use std::ffi::OsStr;
    use std::fs;

    use cap_std::ambient_authority;

    use super::from_handle;

    #[test]
    fn reports_the_stored_name_of_an_opened_folder() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir_all(temp.path().join(".git")).expect("folders");
        let root =
            cap_std::fs::Dir::open_ambient_dir(temp.path(), ambient_authority()).expect("open");
        // A case-sensitive volume cannot open `.GIT`, so there is nothing to check there.
        let Ok(folder) = root.open_dir(".GIT") else {
            return;
        };
        assert_eq!(from_handle(&folder).as_deref(), Some(OsStr::new(".git")));
    }
}

#[cfg(all(test, not(unix)))]
mod tests {
    use std::ffi::OsStr;

    use super::folded;

    #[test]
    fn folds_names_to_one_case() {
        assert_eq!(folded(OsStr::new("README.md")), "readme.md");
        assert_eq!(folded(OsStr::new(".GIT")), ".git");
    }
}
