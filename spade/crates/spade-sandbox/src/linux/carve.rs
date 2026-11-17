//! Carving (ADR 0167 decision 1): Landlock only allows, it has no rule that denies inside an
//! allowed folder. So a readable place holding something on the deny-list is opened child by
//! child around it. Carving works on opened objects, never on path text alone: each place is
//! opened without following a link, a link met while carving is skipped (never followed, never
//! granted), an object that *is* a denied one (same device and inode, a hard link included) is
//! left out, a file met while carving that has another name is left out too, and the very
//! descriptors carving opened are the ones the rules are installed on, so nothing can be swapped
//! in between. Pure over [`Fs`]; [`RealFs`] needs Linux.
//!
//! A rule on a file holds its inode, whatever the path, so a granted hard link would open every
//! other name of the file as well (`~/.ssh/id_ed25519` through a link to it beside a toolchain's
//! credentials). Where its other names are can't be known, so such a file is never granted alone.
//! Inside a folder that is granted whole, a hard link reads as the folder's (as on macOS), but the
//! rule stays on the folder and opens no other name.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::Root;

/// What an opened object is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Dir,
    File,
    /// A symbolic link, opened as itself.
    Link,
}

/// The file system as carving sees it: objects opened without following links, by path or
/// beside an already opened folder.
pub trait Fs {
    type Handle;
    /// Opens `path` itself (a link is opened as the link).
    fn open(&self, path: &Path) -> Option<(Self::Handle, Kind)>;
    /// Opens `name` in the opened folder `dir` (a link is opened as the link).
    fn child(&self, dir: &Self::Handle, name: &std::ffi::OsStr) -> Option<(Self::Handle, Kind)>;
    /// The names in the opened folder `dir`.
    fn names(&self, dir: &Self::Handle) -> Vec<OsString>;
    /// The opened object's device and inode.
    fn id(&self, handle: &Self::Handle) -> Option<(u64, u64)>;
    /// The device and inode of the object at `path`, links followed (a denied place).
    fn id_of(&self, path: &Path) -> Option<(u64, u64)>;
    /// How many names the opened object has (its hard links).
    fn names_of(&self, handle: &Self::Handle) -> u64;
}

/// `root` as opened objects Landlock may grant: the root itself when nothing denied is inside
/// it, nothing when it is or is inside a denied place (by path or as the same object), else its
/// children carved the same way. Links are never followed or granted.
pub fn carve<F: Fs>(fs: &F, root: &Root) -> Vec<(PathBuf, F::Handle)> {
    let denied: HashSet<(u64, u64)> = root.deny.iter().filter_map(|d| fs.id_of(d)).collect();
    let mut out = Vec::new();
    // Roots are named by their real paths: a link in their place was swapped in, and is skipped.
    if let Some((handle, kind)) = fs.open(&root.path)
        && kind != Kind::Link
    {
        walk(fs, root, &denied, root.path.clone(), handle, kind, &mut out);
    }
    out
}

fn walk<F: Fs>(
    fs: &F,
    root: &Root,
    denied: &HashSet<(u64, u64)>,
    path: PathBuf,
    handle: F::Handle,
    kind: Kind,
    out: &mut Vec<(PathBuf, F::Handle)>,
) {
    let is_denied = root.deny.iter().any(|d| path.starts_with(d))
        || fs.id(&handle).is_some_and(|id| denied.contains(&id));
    if is_denied {
        return;
    }
    let holds_denied = root.deny.iter().any(|d| d.starts_with(&path));
    if kind != Kind::Dir || !holds_denied {
        out.push((path, handle));
        return;
    }
    for name in fs.names(&handle) {
        match fs.child(&handle, &name) {
            Some((_, Kind::Link)) | None => {}
            // Granted alone, a file with another name would open that name too.
            Some((child, Kind::File)) if fs.names_of(&child) > 1 => {}
            Some((child, child_kind)) => {
                walk(fs, root, denied, path.join(&name), child, child_kind, out);
            }
        }
    }
}

/// The real file system: `openat` relative to opened folders, never following a link.
#[cfg(all(target_os = "linux", feature = "landlock"))]
pub struct RealFs;

#[cfg(all(target_os = "linux", feature = "landlock"))]
impl Fs for RealFs {
    type Handle = std::os::fd::OwnedFd;

    fn open(&self, path: &Path) -> Option<(Self::Handle, Kind)> {
        open_at(rustix::fs::CWD, path.as_os_str())
    }

    fn child(&self, dir: &Self::Handle, name: &std::ffi::OsStr) -> Option<(Self::Handle, Kind)> {
        open_at(dir, name)
    }

    fn names(&self, dir: &Self::Handle) -> Vec<OsString> {
        use std::os::unix::ffi::OsStrExt;
        // A fresh descriptor for the same folder, readable, to list it.
        let Ok(listing) = rustix::fs::openat(
            dir,
            ".",
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::DIRECTORY
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        ) else {
            return Vec::new();
        };
        let Ok(entries) = rustix::fs::Dir::read_from(&listing) else {
            return Vec::new();
        };
        entries
            .flatten()
            .map(|entry| std::ffi::OsStr::from_bytes(entry.file_name().to_bytes()).to_owned())
            .filter(|name| name != "." && name != "..")
            .collect()
    }

    // `st_dev` and `st_ino` are narrower than `u64` on some targets.
    #[allow(clippy::unnecessary_cast)]
    fn id(&self, handle: &Self::Handle) -> Option<(u64, u64)> {
        rustix::fs::fstat(handle)
            .ok()
            .map(|stat| (stat.st_dev as u64, stat.st_ino as u64))
    }

    fn id_of(&self, path: &Path) -> Option<(u64, u64)> {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
    }

    // `st_nlink` is narrower than `u64` on some targets.
    #[allow(clippy::unnecessary_cast)]
    fn names_of(&self, handle: &Self::Handle) -> u64 {
        // Unknown counts as shared: the file is left out.
        rustix::fs::fstat(handle).map_or(u64::MAX, |stat| stat.st_nlink as u64)
    }
}

/// Opens `name` beside `dir` as itself (`O_PATH | O_NOFOLLOW`), with what it is.
#[cfg(all(target_os = "linux", feature = "landlock"))]
fn open_at(
    dir: impl std::os::fd::AsFd,
    name: &std::ffi::OsStr,
) -> Option<(std::os::fd::OwnedFd, Kind)> {
    use rustix::fs::{FileType, Mode, OFlags};
    let fd = rustix::fs::openat(
        dir,
        name,
        OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .ok()?;
    let kind = match FileType::from_raw_mode(rustix::fs::fstat(&fd).ok()?.st_mode) {
        FileType::Directory => Kind::Dir,
        FileType::Symlink => Kind::Link,
        _ => Kind::File,
    };
    Some((fd, kind))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// A fake tree of objects by path. Links name their target; a hard link shares an id.
    #[derive(Default)]
    struct Tree {
        kinds: HashMap<PathBuf, (Kind, u64)>,
        links: HashMap<PathBuf, PathBuf>,
    }

    impl Tree {
        fn dir(mut self, path: &str, id: u64) -> Self {
            self.kinds.insert(PathBuf::from(path), (Kind::Dir, id));
            self
        }
        fn file(mut self, path: &str, id: u64) -> Self {
            self.kinds.insert(PathBuf::from(path), (Kind::File, id));
            self
        }
        fn link(mut self, path: &str, target: &str) -> Self {
            self.kinds.insert(PathBuf::from(path), (Kind::Link, 0));
            self.links
                .insert(PathBuf::from(path), PathBuf::from(target));
            self
        }
    }

    impl Fs for Tree {
        type Handle = PathBuf;

        fn open(&self, path: &Path) -> Option<(PathBuf, Kind)> {
            self.kinds
                .get(path)
                .map(|(kind, _)| (path.to_path_buf(), *kind))
        }

        fn child(&self, dir: &PathBuf, name: &std::ffi::OsStr) -> Option<(PathBuf, Kind)> {
            self.open(&dir.join(name))
        }

        fn names(&self, dir: &PathBuf) -> Vec<OsString> {
            let mut names: Vec<OsString> = self
                .kinds
                .keys()
                .filter(|p| p.parent() == Some(dir.as_path()))
                .filter_map(|p| p.file_name().map(ToOwned::to_owned))
                .collect();
            names.sort();
            names
        }

        fn id(&self, handle: &PathBuf) -> Option<(u64, u64)> {
            self.kinds.get(handle).map(|(_, id)| (1, *id))
        }

        fn id_of(&self, path: &Path) -> Option<(u64, u64)> {
            let target = self.links.get(path).map_or(path, PathBuf::as_path);
            self.id(&target.to_path_buf())
        }

        fn names_of(&self, handle: &PathBuf) -> u64 {
            let Some((Kind::File, id)) = self.kinds.get(handle) else {
                return 1;
            };
            let same = |(kind, other): &(Kind, u64)| *kind == Kind::File && other == id;
            u64::try_from(self.kinds.values().filter(|v| same(v)).count()).unwrap_or(u64::MAX)
        }
    }

    fn root(path: &str, deny: &[&str]) -> Root {
        Root {
            path: PathBuf::from(path),
            write: false,
            deny: deny.iter().map(PathBuf::from).collect(),
        }
    }

    fn granted(tree: &Tree, root: &Root) -> Vec<PathBuf> {
        carve(tree, root)
            .into_iter()
            .map(|(path, _)| path)
            .collect()
    }

    fn home() -> Tree {
        Tree::default()
            .dir("/h", 1)
            .dir("/h/.ssh", 2)
            .file("/h/.ssh/id", 3)
            .dir("/h/.cargo", 4)
            .dir("/h/.cargo/bin", 5)
            .file("/h/.cargo/credentials.toml", 6)
            .dir("/h/code", 7)
    }

    #[test]
    fn a_readable_folder_is_opened_around_what_the_deny_list_holds() {
        let tree = home();
        let deny = &["/h/.ssh", "/h/.cargo/credentials.toml"];
        assert_eq!(
            granted(&tree, &root("/h", deny)),
            vec![PathBuf::from("/h/.cargo/bin"), PathBuf::from("/h/code")]
        );
        assert!(granted(&tree, &root("/h/.ssh", deny)).is_empty());
        assert_eq!(
            granted(&tree, &root("/h/code", deny)),
            vec![PathBuf::from("/h/code")]
        );
    }

    #[test]
    fn a_link_beside_a_denied_place_never_grants_its_target() {
        // ~/.cargo/alias -> ~/.ssh: carving ~/.cargo (it holds a denied file) skips the link.
        let tree = home().link("/h/.cargo/alias", "/h/.ssh");
        let root = root("/h/.cargo", &["/h/.ssh", "/h/.cargo/credentials.toml"]);
        assert_eq!(granted(&tree, &root), vec![PathBuf::from("/h/.cargo/bin")]);
    }

    #[test]
    fn a_root_that_became_a_link_is_not_followed() {
        let tree = home().link("/h/tools", "/h/.ssh");
        assert!(granted(&tree, &root("/h/tools", &["/h/.ssh"])).is_empty());
    }

    #[test]
    fn a_file_with_another_name_is_never_granted_alone() {
        // ~/.cargo/copy is a hard link to ~/.ssh/id: a rule on it would open ~/.ssh/id too.
        let tree = home().file("/h/.cargo/copy", 3);
        let root = root("/h/.cargo", &["/h/.ssh", "/h/.cargo/credentials.toml"]);
        assert_eq!(granted(&tree, &root), vec![PathBuf::from("/h/.cargo/bin")]);
        // A file with one name beside a denied one is granted.
        let tree = home().file("/h/.cargo/config.toml", 9);
        assert_eq!(
            granted(&tree, &root),
            vec![
                PathBuf::from("/h/.cargo/bin"),
                PathBuf::from("/h/.cargo/config.toml")
            ]
        );
    }

    #[test]
    fn a_hard_link_to_a_denied_file_is_left_out_as_the_same_object() {
        // ~/.cargo/copy is the same inode as ~/.ssh/id.
        let tree = home().file("/h/.cargo/copy", 3);
        let root = root("/h/.cargo", &["/h/.ssh/id", "/h/.cargo/credentials.toml"]);
        assert_eq!(granted(&tree, &root), vec![PathBuf::from("/h/.cargo/bin")]);
    }
}
