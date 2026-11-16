//! Linux's sandbox (ADR 0167 decision 1): a Landlock ruleset that Spade's own binary, started as
//! a launcher (`spade sandbox-exec <plan> <program> <args>…`), applies to itself before it runs
//! the command. Landlock only allows: it has no rule that denies inside an allowed folder. So a
//! readable place holding something on the deny-list is opened child by child around it
//! ([`carve`]).
//!
//! Carving works on opened objects, never on path text alone: each place is opened without
//! following a link, a link met while carving is skipped (never followed, never granted), an
//! object that *is* a denied one (same device and inode, a hard link included) is left out, and
//! the very descriptors carving opened are the ones the rules are installed on, so nothing can be
//! swapped in between. The plan and the carving are pure over [`Fs`] and tested everywhere;
//! applying them needs Linux and the `landlock` feature.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::policy::Policy;

/// The launcher's first argument.
pub const LAUNCHER_ARG: &str = "sandbox-exec";

/// System folders a command reads and runs from. The home folder, `/root`, `/mnt`, `/media`,
/// `/srv`, `/run`, `/tmp` and the rest of `/var` are not among them, so they stay hidden.
const SYSTEM: &[&str] = &[
    "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt", "/nix", "/snap",
    "/var/lib", "/proc", "/sys", "/dev",
];

/// Device nodes a command may write.
const DEVICES: &[&str] = &["/dev/null", "/dev/zero", "/dev/tty", "/dev/pts"];

/// One place to open, with what may not be reached inside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Root {
    pub path: PathBuf,
    pub write: bool,
    /// Places inside (or equal to) it that stay closed.
    pub deny: Vec<PathBuf>,
}

/// What the launcher applies: its roots and the one port it may connect to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub roots: Vec<Root>,
    pub proxy_port: Option<u16>,
}

/// The plan for `policy`. Pure: what is opened, and around what, is decided by the launcher.
pub fn plan(policy: &Policy) -> Plan {
    let mut roots = Vec::new();
    let mut add = |paths: &mut dyn Iterator<Item = PathBuf>, write: bool, deny: &[PathBuf]| {
        for path in paths {
            roots.push(Root {
                path,
                write,
                deny: deny.to_vec(),
            });
        }
    };
    add(&mut SYSTEM.iter().map(PathBuf::from), false, &policy.deny);
    add(&mut policy.read.iter().cloned(), false, &policy.deny);
    add(&mut policy.write.iter().cloned(), true, &policy.deny);
    // A plugin's folder sits inside ace's data, which is denied: only credentials stay closed.
    add(&mut policy.reopen.iter().cloned(), false, &policy.secrets);
    // The workspace is inside Spade's data folder: only denied places inside it are closed.
    let inside: Vec<PathBuf> = policy
        .deny
        .iter()
        .filter(|d| d.starts_with(&policy.workspace) && **d != policy.workspace)
        .cloned()
        .collect();
    add(
        &mut std::iter::once(policy.workspace.clone()),
        true,
        &inside,
    );
    add(&mut policy.scratch.iter().cloned(), true, &policy.secrets);
    add(&mut DEVICES.iter().map(PathBuf::from), true, &[]);
    Plan {
        roots,
        proxy_port: policy.proxy_port,
    }
}

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

/// Carves `plan`, applies it to this process and runs `program` in its place. Answers only on
/// failure.
#[cfg(all(target_os = "linux", feature = "landlock"))]
pub fn exec(plan: &Plan, program: &std::ffi::OsStr, args: &[std::ffi::OsString]) -> String {
    use std::os::unix::process::CommandExt;

    match restrict(plan) {
        Ok(()) => {
            let error = std::process::Command::new(program).args(args).exec();
            format!("the command could not start: {error}")
        }
        Err(error) => format!("the sandbox could not be applied: {error}"),
    }
}

#[cfg(all(target_os = "linux", feature = "landlock"))]
fn restrict(plan: &Plan) -> Result<(), landlock::RulesetError> {
    use landlock::{
        ABI, Access, AccessFs, AccessNet, NetPort, PathBeneath, Ruleset, RulesetAttr,
        RulesetCreatedAttr,
    };

    let abi = ABI::V5;
    // Every TCP connect is handled, so with no port in the plan none is allowed.
    let mut created = Ruleset::default()
        .handle_access(AccessFs::from_all(abi))?
        .handle_access(AccessNet::ConnectTcp)?
        .create()?;
    for root in &plan.roots {
        let access = if root.write {
            AccessFs::from_all(abi)
        } else {
            AccessFs::from_read(abi)
        };
        // The descriptors carving opened are the ones the rules hold.
        for (_, fd) in carve(&RealFs, root) {
            created = created.add_rule(PathBeneath::new(fd, access))?;
        }
    }
    if let Some(port) = plan.proxy_port {
        created = created.add_rule(NetPort::new(port, AccessNet::ConnectTcp))?;
    }
    created.restrict_self()?;
    Ok(())
}

/// Whether this kernel enforces Landlock for files and for TCP connects.
#[cfg(all(target_os = "linux", feature = "landlock"))]
pub fn supported() -> (bool, bool) {
    use landlock::{
        ABI, Access, AccessFs, AccessNet, CompatLevel, Compatible, Ruleset, RulesetAttr,
    };

    let files = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_all(ABI::V1))
        .and_then(|r| r.create())
        .is_ok();
    let network = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessNet::ConnectTcp)
        .and_then(|r| r.create())
        .is_ok();
    (files, network)
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
    fn a_hard_link_to_a_denied_file_is_left_out_as_the_same_object() {
        // ~/.cargo/copy is the same inode as ~/.ssh/id.
        let tree = home().file("/h/.cargo/copy", 3);
        let root = root("/h/.cargo", &["/h/.ssh/id", "/h/.cargo/credentials.toml"]);
        assert_eq!(granted(&tree, &root), vec![PathBuf::from("/h/.cargo/bin")]);
    }

    #[test]
    fn the_plan_writes_only_the_workspace_granted_folders_scratch_and_devices() {
        let policy = Policy {
            workspace: "/h/spade/workspace/b1".into(),
            temp: "/h/spade/workspace/b1/.spade/tmp".into(),
            write: vec!["/h/code".into()],
            read: vec!["/h/.cargo".into()],
            hide: vec!["/h".into()],
            deny: vec!["/h/.cargo/credentials.toml".into(), "/h/spade".into()],
            secrets: vec!["/h/.cargo/credentials.toml".into()],
            reopen: vec![],
            scratch: vec!["/h/spade/terminal/b1".into()],
            proxy_port: Some(4100),
        };
        let plan = plan(&policy);
        let written: Vec<&Path> = plan
            .roots
            .iter()
            .filter(|r| r.write)
            .map(|r| r.path.as_path())
            .collect();
        assert_eq!(
            written,
            vec![
                Path::new("/h/code"),
                Path::new("/h/spade/workspace/b1"),
                Path::new("/h/spade/terminal/b1"),
                Path::new("/dev/null"),
                Path::new("/dev/zero"),
                Path::new("/dev/tty"),
                Path::new("/dev/pts"),
            ]
        );
        let workspace = plan
            .roots
            .iter()
            .find(|r| r.path == Path::new("/h/spade/workspace/b1"));
        assert_eq!(workspace.map(|r| r.deny.len()), Some(0));
        let cargo = plan.roots.iter().find(|r| r.path == Path::new("/h/.cargo"));
        assert_eq!(cargo.map(|r| r.deny.clone()), Some(policy.deny.clone()));
        assert_eq!(plan.proxy_port, Some(4100));
    }
}
