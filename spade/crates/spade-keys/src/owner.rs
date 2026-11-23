//! Spade owning its keychain entries (ADR 0119 amendment 1): where the platform lets Spade set an
//! entry's access list (macOS), every entry it writes trusts Spade by its code signature, and an
//! entry from before that is filed again once, the first time this process reads it.
//!
//! [`Owner`] is the seam: the macOS shell sits behind it, tests pass a fake, and Windows and
//! Linux have none (their stores already tie an entry to the signed-in user, not to a binary).

use std::path::Path;

/// The keychain service a release Spade on the person's live home files its entries under.
pub const SERVICE: &str = "dev.acehq.spade";

/// The start of the service every other Spade files under (a local build, or any home but the
/// live one), followed by `.` and that home's slot: dev and live Spade, and any two homes, never
/// read or write each other's entries (issue #2651).
pub const DEV_SERVICE: &str = "dev.acehq.spade.dev";

/// The code-signing requirement of the released Spade: identifier `spade`, signed with ace's
/// Developer ID (team 5J88TLUP2J). Every release, updates included, satisfies it; a local build
/// signed any other way doesn't.
pub const RELEASE_REQUIREMENT: &str = "identifier \"spade\" and anchor apple generic and \
     certificate 1[field.1.2.840.113635.100.6.2.6] and \
     certificate leaf[field.1.2.840.113635.100.6.1.13] and \
     certificate leaf[subject.OU] = \"5J88TLUP2J\"";

/// The comment Spade's own entries carry, so one filed before Spade set access lists is told
/// apart without reading its secret.
pub const OWNED_MARK: &str = "spade: access by code signature (1)";

/// What decides which service this Spade files its entries under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    /// The binary is the released, Developer ID signed Spade (always true off macOS, where
    /// binaries aren't told apart).
    pub release_binary: bool,
    /// Spade's data folder is the live home's: `<user home>/.ace/spade`.
    pub live_home: bool,
    /// The data folder's slot (see [`home_slot`]).
    pub home_slot: String,
}

impl Placement {
    /// This process's placement: whether it runs the release binary, and whether `data_dir` is
    /// the live home's under `user_home`.
    pub fn of_this_process(data_dir: &Path, user_home: Option<&Path>) -> Self {
        Self {
            release_binary: release_binary(),
            live_home: user_home.is_some_and(|home| is_live_home(data_dir, home)),
            home_slot: home_slot(data_dir),
        }
    }

    /// The service this placement files entries under: [`SERVICE`] for a release Spade on the
    /// live home, `<DEV_SERVICE>.<home slot>` for anything else.
    pub fn service(&self) -> String {
        if self.release_binary && self.live_home {
            SERVICE.to_owned()
        } else {
            format!("{DEV_SERVICE}.{}", self.home_slot)
        }
    }
}

/// A data folder's slot: the first 16 hex characters of the SHA-256 of its path, with links
/// resolved where it exists. Two folders never share one; one folder reached through a link keeps
/// its own.
pub fn home_slot(data_dir: &Path) -> String {
    use sha2::Digest;
    let path = data_dir
        .canonicalize()
        .unwrap_or_else(|_| data_dir.to_path_buf());
    let digest = sha2::Sha256::digest(path.to_string_lossy().as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether `data_dir` is the live home's Spade folder, `<user_home>/.ace/spade`: compared after
/// resolving links where both exist, as written otherwise.
pub fn is_live_home(data_dir: &Path, user_home: &Path) -> bool {
    let live = user_home.join(".ace").join("spade");
    match (data_dir.canonicalize(), live.canonicalize()) {
        (Ok(data), Ok(live)) => data == live,
        _ => data_dir == live,
    }
}

/// Whether this process is the released Spade (see [`RELEASE_REQUIREMENT`]).
#[cfg(target_os = "macos")]
pub fn release_binary() -> bool {
    spade_keychain_macos::running_code_satisfies(RELEASE_REQUIREMENT)
}

/// Off macOS binaries aren't told apart: the home alone decides.
#[cfg(not(target_os = "macos"))]
pub fn release_binary() -> bool {
    true
}

/// Writes entries with Spade's own access list, and tells whether an entry was written so.
pub trait Owner: Send + Sync {
    /// Stores `secret` under `service`/`account`, replacing any entry there, with an access list
    /// that trusts Spade by its code signature and [`OWNED_MARK`] as its comment.
    fn write(&self, service: &str, account: &str, secret: &str) -> Result<(), String>;

    /// Whether the entry at `service`/`account` carries [`OWNED_MARK`], read without its secret.
    /// No entry reads as owned: there is nothing to file again.
    fn owns(&self, service: &str, account: &str) -> Result<bool, String>;
}

/// The macOS owner: login keychain items whose access list trusts the running Spade's designated
/// requirement.
#[cfg(target_os = "macos")]
pub(crate) struct MacOwner;

#[cfg(target_os = "macos")]
impl Owner for MacOwner {
    fn write(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
        let label = format!("Spade: {account}");
        let item = spade_keychain_macos::Item {
            service,
            account,
            label: &label,
            comment: OWNED_MARK,
        };
        spade_keychain_macos::replace_owned(&item, secret.as_bytes()).map_err(|e| e.to_string())
    }

    fn owns(&self, service: &str, account: &str) -> Result<bool, String> {
        match spade_keychain_macos::comment(service, account) {
            Ok(Some(comment)) => Ok(comment == OWNED_MARK),
            // An item with no comment is one Spade filed before it set access lists. (No item at
            // all also lands here; filing it again then writes what this process just read.)
            Ok(None) => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_release_spade_on_the_live_home_uses_the_live_service() {
        let at = |release_binary, live_home| {
            Placement {
                release_binary,
                live_home,
                home_slot: "0123456789abcdef".to_owned(),
            }
            .service()
        };
        let dev = "dev.acehq.spade.dev.0123456789abcdef";
        assert_eq!(at(true, true), SERVICE);
        assert_eq!(at(false, true), dev, "a local build on the live home");
        assert_eq!(at(true, false), dev, "the release binary on a dev home");
        assert_eq!(at(false, false), dev);
    }

    #[test]
    fn each_home_has_its_own_slot_and_a_link_to_one_shares_it() -> std::io::Result<()> {
        let root = tempfile::tempdir()?;
        let (a, b) = (root.path().join("a"), root.path().join("b"));
        std::fs::create_dir_all(&a)?;
        std::fs::create_dir_all(&b)?;
        assert_ne!(home_slot(&a), home_slot(&b));
        assert_eq!(home_slot(&a), home_slot(&root.path().join("./a")));
        assert_eq!(home_slot(&a).len(), 16);
        #[cfg(unix)]
        {
            let link = root.path().join("link");
            std::os::unix::fs::symlink(&a, &link)?;
            assert_eq!(home_slot(&a), home_slot(&link));
        }
        Ok(())
    }

    #[test]
    fn the_live_home_is_the_users_ace_spade_folder_even_through_a_link() -> std::io::Result<()> {
        let root = tempfile::tempdir()?;
        let user = root.path().join("user");
        std::fs::create_dir_all(user.join(".ace/spade"))?;
        std::fs::create_dir_all(user.join(".ace/dev-spade"))?;
        assert!(is_live_home(&user.join(".ace/spade"), &user));
        assert!(is_live_home(&user.join(".ace/./spade"), &user));
        assert!(!is_live_home(&user.join(".ace/dev-spade"), &user));
        assert!(!is_live_home(&root.path().join("elsewhere/spade"), &user));
        #[cfg(unix)]
        {
            let link = root.path().join("linked");
            std::os::unix::fs::symlink(user.join(".ace/spade"), &link)?;
            assert!(is_live_home(&link, &user));
        }
        // A home not made yet is matched as written.
        let fresh = root.path().join("fresh");
        assert!(is_live_home(&fresh.join(".ace/spade"), &fresh));
        Ok(())
    }
}
