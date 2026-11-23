//! Whether a program Spade found is one it may run on the host to build the machine's Python
//! (ADR 0220): never one a bot could have put or changed there. The candidate is resolved fully;
//! the resolved file and every folder above it, and every folder above the name it was found
//! by, must be owned by root or by the user Spade runs as, never writable by others (a
//! root-owned folder with the sticky bit, such as `/tmp`, passes), and writable by its group only
//! when that group is root's own or, on macOS, `admin` (whose members can become root anyway, as
//! Homebrew's folders are); and neither the file nor the folder it was found in may lie inside a
//! bot's workspace or a folder a bot may write.

use std::path::{Path, PathBuf};

/// Where nothing Spade runs on the host may come from, and who may own what it runs.
#[derive(Debug, Clone, Default)]
pub struct Places {
    /// Bots' workspaces and every folder a bot may write, as given (resolved here).
    pub forbidden: Vec<PathBuf>,
    /// Spade's own folders inside a forbidden one (its shared Python), which are fine.
    pub allowed: Vec<PathBuf>,
    /// The user Spade runs as.
    pub owner: u32,
}

/// `candidate` resolved, if Spade may run it; else why not, in words.
#[cfg(unix)]
pub fn vet(candidate: &Path, places: &Places) -> Result<PathBuf, String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let shown = candidate.display();
    if !candidate.is_absolute() {
        return Err(format!("{shown} isn't an absolute path"));
    }
    let resolved =
        std::fs::canonicalize(candidate).map_err(|e| format!("{shown} can't be resolved: {e}"))?;
    let meta = std::fs::metadata(&resolved).map_err(|e| format!("{shown}: {e}"))?;
    if !meta.is_file() || meta.permissions().mode() & 0o111 == 0 {
        return Err(format!("{shown} isn't a program"));
    }
    let real = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let forbidden: Vec<PathBuf> = places.forbidden.iter().map(|p| real(p)).collect();
    let allowed: Vec<PathBuf> = places.allowed.iter().map(|p| real(p)).collect();
    let inside = |path: &Path| {
        forbidden.iter().any(|f| path.starts_with(f))
            && !allowed.iter().any(|a| path.starts_with(a))
    };
    // The folders the name was found through, as they resolve, and the resolved file's.
    let found_in = candidate
        .parent()
        .map(real)
        .ok_or_else(|| format!("{shown} has no folder"))?;
    for path in [&resolved, &found_in] {
        if inside(path) {
            return Err(format!(
                "{shown} is in a bot's workspace or a folder a bot may write ({})",
                path.display()
            ));
        }
    }
    let mut checked: Vec<PathBuf> = vec![resolved.clone()];
    checked.extend(resolved.ancestors().skip(1).map(Path::to_path_buf));
    checked.extend(found_in.ancestors().map(Path::to_path_buf));
    for path in &checked {
        let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let owner = meta.uid();
        if owner != 0 && owner != places.owner {
            return Err(format!(
                "{} belongs to another user, so it could change what {shown} is",
                path.display()
            ));
        }
        let mode = meta.permissions().mode();
        let sticky_root = meta.is_dir() && owner == 0 && mode & 0o1000 != 0;
        let group_writable = mode & 0o020 != 0 && !root_equivalent(meta.gid());
        let others_writable = mode & 0o002 != 0 && !sticky_root;
        if group_writable || others_writable {
            return Err(format!(
                "{} can be changed by other users, so it could change what {shown} is",
                path.display()
            ));
        }
    }
    Ok(resolved)
}

/// A group whose members can already become root, so its write lets in nobody new.
#[cfg(unix)]
fn root_equivalent(gid: u32) -> bool {
    gid == 0 || (cfg!(target_os = "macos") && gid == 80)
}

#[cfg(not(unix))]
pub fn vet(candidate: &Path, _places: &Places) -> Result<PathBuf, String> {
    Err(format!(
        "{} isn't run: Spade builds Python only on macOS and Linux",
        candidate.display()
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    use super::*;

    fn program(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap_or(Path::new("/"))).unwrap_or_default();
        std::fs::write(path, "#!/bin/sh\n").unwrap_or_default();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap_or_default();
    }

    /// A temporary folder whose own place passes, or `None` when this machine's temporary
    /// folders don't (then there is nothing to compare against).
    fn root() -> Option<(tempfile::TempDir, Places)> {
        let dir = tempfile::tempdir().ok()?;
        let owner = std::fs::metadata(dir.path()).ok()?.uid();
        let places = Places {
            owner,
            ..Places::default()
        };
        let probe = dir.path().join("probe/tool");
        program(&probe);
        vet(&probe, &places).ok()?;
        Some((dir, places))
    }

    #[test]
    fn a_program_in_a_place_only_its_owner_can_change_is_used_as_it_resolves() {
        let Some((dir, places)) = root() else {
            return;
        };
        let tool = dir.path().join("bin/uv");
        program(&tool);
        assert_eq!(vet(&tool, &places).ok(), std::fs::canonicalize(&tool).ok());
    }

    #[test]
    fn a_program_in_a_bots_folder_or_reached_through_a_link_into_one_is_refused() {
        let Some((dir, mut places)) = root() else {
            return;
        };
        let granted = dir.path().join("granted");
        let planted = granted.join("uv");
        program(&planted);
        places.forbidden = vec![granted.clone()];
        let why = vet(&planted, &places).err().unwrap_or_default();
        assert!(why.contains("a folder a bot may write"), "{why}");
        // Found by a name in a safe folder, but resolving into the bot's.
        let safe = dir.path().join("bin");
        std::fs::create_dir_all(&safe).unwrap_or_default();
        std::os::unix::fs::symlink(&planted, safe.join("uv")).unwrap_or_default();
        assert!(vet(&safe.join("uv"), &places).is_err());
        // Spade's own folder inside a forbidden one is fine.
        let shared = granted.join(".python/shared/pythons/python3");
        program(&shared);
        places.allowed = vec![granted.join(".python/shared")];
        assert!(vet(&shared, &places).is_ok());
    }

    #[test]
    fn a_program_in_a_folder_others_can_change_is_refused() {
        let Some((dir, places)) = root() else {
            return;
        };
        let open = dir.path().join("open");
        program(&open.join("uv"));
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap_or_default();
        let why = vet(&open.join("uv"), &places).err().unwrap_or_default();
        assert!(why.contains("can be changed by other users"), "{why}");
    }
}
