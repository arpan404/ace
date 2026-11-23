//! Spade owning its keychain entries (ADR 0119 amendment 1): where the platform lets Spade set an
//! entry's access list (macOS), every entry it creates trusts Spade by its code signature. An
//! entry from before keeps its access list; only its secret is updated, in place.
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
/// signed any other way doesn't. The identifier `spade` under that Developer ID is reserved for
/// release signing: anything else signed so counts as the release (`spade/docs/dev-signing.md`).
/// Kept in one file that `spade/scripts/check-release-identity.sh` checks each release against.
pub const RELEASE_REQUIREMENT: &str = include_str!("../release-requirement.txt");

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
    /// the live home's under the OS account's home ([`account_home`]). Call it once `data_dir`
    /// exists, so its slot is taken from its resolved path.
    pub fn of_this_process(data_dir: &Path) -> Self {
        Self {
            release_binary: release_binary(),
            live_home: account_home().is_some_and(|home| is_live_home(data_dir, &home)),
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

/// What [`Owner::create`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Created {
    /// A new entry, with Spade's access list.
    Added,
    /// An entry was already there and was left exactly as it is: the caller updates its secret
    /// in place, keeping its access list.
    Exists,
}

/// Creates entries with Spade's own access list. It never deletes or replaces an entry: an
/// existing item's access list can't be changed without its owner's consent, and deleting it to
/// file a new one could lose the secret, so items from before keep theirs (ADR 0119 amendment 1).
pub trait Owner: Send + Sync {
    /// Adds `secret` under `service`/`account` with an access list that trusts Spade by its code
    /// signature and [`OWNED_MARK`] as its comment, unless an entry is already there.
    fn create(&self, service: &str, account: &str, secret: &str) -> Result<Created, String>;
}

/// The macOS owner: login keychain items whose access list trusts the running Spade's designated
/// requirement.
#[cfg(target_os = "macos")]
pub(crate) struct MacOwner;

#[cfg(target_os = "macos")]
impl Owner for MacOwner {
    fn create(&self, service: &str, account: &str, secret: &str) -> Result<Created, String> {
        let label = format!("Spade: {account}");
        let item = spade_keychain_macos::Item {
            service,
            account,
            label: &label,
            comment: OWNED_MARK,
        };
        match spade_keychain_macos::add_owned(&item, secret.as_bytes()) {
            Ok(true) => Ok(Created::Added),
            Ok(false) => Ok(Created::Exists),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// The signed-in OS account's home folder, from the account database (`getpwuid`), not from
/// `HOME`, so a caller can't make another folder look like the live home. Windows has no
/// per-binary keychain access to protect, so its profile folder comes from `USERPROFILE`.
#[cfg(unix)]
pub fn account_home() -> Option<std::path::PathBuf> {
    nix::unistd::User::from_uid(nix::unistd::Uid::current())
        .ok()
        .flatten()
        .map(|user| user.dir)
}

/// See the Unix version.
#[cfg(not(unix))]
pub fn account_home() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)
}

/// Why this Spade may not open its data folder: a build other than the released one on the live
/// home. It would file under another keychain service, so the live home's endpoints would look
/// keyless and the guard against moving a keyed endpoint to a new host would let one through;
/// the release Spade would then send the live key there.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "this Spade is not the released build, so it may not open the live home's folder {live}; \
     run it with SPADE_DATA_DIR set to another folder, for example {suggested}"
)]
pub struct NotForLiveHome {
    pub live: String,
    pub suggested: String,
}

/// Refuses a build other than the released one on the live home (see [`NotForLiveHome`]).
pub fn may_open(
    data_dir: &Path,
    release_binary: bool,
    account_home: Option<&Path>,
) -> Result<(), NotForLiveHome> {
    match account_home {
        Some(home) if !release_binary && is_live_home(data_dir, home) => Err(NotForLiveHome {
            live: data_dir.display().to_string(),
            suggested: home
                .join(".ace")
                .join("dev-spade")
                .join("spade")
                .display()
                .to_string(),
        }),
        _ => Ok(()),
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
    fn a_build_other_than_the_release_is_refused_on_the_live_home_only() -> std::io::Result<()> {
        let root = tempfile::tempdir()?;
        let user = root.path().join("user");
        std::fs::create_dir_all(user.join(".ace/spade"))?;
        let live = user.join(".ace/spade");
        let refused = may_open(&live, false, Some(&user)).err();
        assert!(
            refused
                .as_ref()
                .is_some_and(|r| r.to_string().contains("dev-spade")),
            "{refused:?}"
        );
        assert!(
            may_open(&live, true, Some(&user)).is_ok(),
            "the release build"
        );
        assert!(may_open(&user.join(".ace/dev-spade/spade"), false, Some(&user)).is_ok());
        Ok(())
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
