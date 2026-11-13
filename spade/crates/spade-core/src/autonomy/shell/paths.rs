//! Where a command's paths lead. Containment is decided on real paths: the engine resolves a
//! path against the folder the command runs in, with symlinked parents followed, and says
//! whether the result is inside the bot's workspace ([`Place`]). What can't be resolved counts as
//! outside.

use std::path::{Component, Path, PathBuf};

/// Why a file couldn't be shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unseen {
    Missing,
    TooLarge,
    Unreadable,
}

/// The folder a command runs in, as the classifier asks about it. The engine answers from the
/// file system; [`Lexical`] answers without one.
pub trait Place {
    /// The real path `path` names, relative to the folder the command starts in, with symlinks
    /// in the longest part that exists followed and the rest added as written. `None` when that
    /// can't be established (a broken link, an unreadable folder).
    fn resolve(&self, path: &str) -> Option<PathBuf>;
    /// Whether a real path lies inside the bot's workspace.
    fn contains(&self, real: &Path) -> bool;
    /// A file's text, when it is at most `longest` bytes.
    fn read(&self, real: &Path, longest: usize) -> Result<String, Unseen>;
    /// The names in a folder.
    fn list(&self, real: &Path) -> Result<Vec<String>, Unseen>;
}

/// `place`, with commands starting in another folder (`cd x &&`, `make -C x`, `npm --prefix x`).
pub struct Moved<'a> {
    inner: &'a dyn Place,
    cwd: PathBuf,
}

/// `place` moved to `dir` (relative to where it starts); `None` when `dir` can't be resolved
/// (a variable, the home folder, a broken link).
pub fn moved<'a>(place: &'a dyn Place, dir: &str) -> Option<Moved<'a>> {
    if dir.is_empty() || dir.starts_with('~') || dir.contains('$') || dir.contains('`') {
        return None;
    }
    Some(Moved {
        inner: place,
        cwd: place.resolve(dir)?,
    })
}

impl Place for Moved<'_> {
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        if Path::new(path).is_absolute() {
            return self.inner.resolve(path);
        }
        self.inner.resolve(&self.cwd.join(path).to_string_lossy())
    }

    fn contains(&self, real: &Path) -> bool {
        self.inner.contains(real)
    }

    fn read(&self, real: &Path, longest: usize) -> Result<String, Unseen> {
        self.inner.read(real, longest)
    }

    fn list(&self, real: &Path) -> Result<Vec<String>, Unseen> {
        self.inner.list(real)
    }
}

/// A place with no file system: the command starts at the workspace's top, paths are followed
/// as written, and no file can be read (so a script it runs can't be shown).
pub struct Lexical;

/// Where [`Lexical`] puts the workspace.
const ROOT: &str = "/workspace";

impl Place for Lexical {
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        let path = Path::new(path);
        let joined = if path.is_absolute() {
            path.to_path_buf()
        } else {
            Path::new(ROOT).join(path)
        };
        Some(normalized(&joined))
    }

    fn contains(&self, real: &Path) -> bool {
        real.starts_with(ROOT)
    }

    fn read(&self, _real: &Path, _longest: usize) -> Result<String, Unseen> {
        Err(Unseen::Unreadable)
    }

    fn list(&self, _real: &Path) -> Result<Vec<String>, Unseen> {
        Err(Unseen::Unreadable)
    }
}

/// `path` with `.` and `..` taken out as written.
pub fn normalized(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// Whether writing to, deleting or moving `path` reaches outside the bot's workspace: through
/// the home folder, a variable or a substitution Spade can't read, a glob that climbs, or a real
/// path that resolves outside (or doesn't resolve).
pub(super) fn outside(place: &dyn Place, path: &str) -> bool {
    let path = path.trim();
    if matches!(
        path,
        "/dev/null" | "/dev/stdout" | "/dev/stderr" | "/dev/tty" | "-"
    ) || path.starts_with("/dev/fd/")
    {
        return false;
    }
    if path.is_empty() || path.starts_with('~') || path.contains('$') || path.contains('`') {
        return true;
    }
    // A Windows drive or share.
    if path.contains(":\\") || path.contains(":/") || path.starts_with("\\\\") {
        return true;
    }
    // A glob matches only under the part before it, unless a later part climbs.
    let parts: Vec<&str> = path.split('/').collect();
    let base = match parts.iter().position(|p| p.contains(['*', '?', '[', '{'])) {
        Some(at) => {
            if parts[at..].contains(&"..") {
                return true;
            }
            let base = parts[..at].join("/");
            match (base.is_empty(), path.starts_with('/')) {
                (true, true) => "/".to_owned(),
                (true, false) => ".".to_owned(),
                _ => base,
            }
        }
        None => path.to_owned(),
    };
    match place.resolve(&base) {
        Some(real) => !place.contains(&real),
        None => true,
    }
}
