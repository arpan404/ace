//! The credential deny-list (ADR 0167 decision 2): places where sign-ins, keys and tokens live,
//! never readable in any sandbox whatever else a policy allows. The word list in
//! `spade_core::autonomy::secrets` stays as a second line in front of it.

use std::path::{Path, PathBuf};

/// Under the person's home folder.
const IN_HOME: &[&str] = &[
    // SSH, GnuPG and pass.
    ".ssh",
    ".gnupg",
    ".password-store",
    // Cloud CLIs.
    ".aws",
    ".azure",
    ".config/gcloud",
    ".kube",
    ".oci",
    ".docker/config.json",
    // Git and package tokens.
    ".netrc",
    ".git-credentials",
    ".config/git/credentials",
    ".config/gh",
    ".config/hub",
    ".npmrc",
    ".yarnrc.yml",
    ".pypirc",
    ".gem/credentials",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".terraform.d/credentials.tfrc.json",
    // Coding agents' sign-ins.
    ".codex",
    ".claude",
    ".claude.json",
    ".config/opencode",
    ".local/share/opencode",
    ".cursor",
    ".gemini",
    ".config/github-copilot",
    // Keychains and secret stores.
    "Library/Keychains",
    ".local/share/keyrings",
];

/// Outside the home folder.
const SYSTEM: &[&str] = &["/Library/Keychains"];

/// Every place on the deny-list for a person whose home folder is `home`.
pub fn places(home: &Path) -> Vec<PathBuf> {
    IN_HOME
        .iter()
        .map(|place| home.join(place))
        .chain(SYSTEM.iter().map(PathBuf::from))
        .collect()
}

/// Whether `path` is on the deny-list or inside a place on it.
pub fn denied(home: &Path, path: &Path) -> bool {
    places(home).iter().any(|place| path.starts_with(place))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_ins_keys_and_tokens_are_on_the_list() {
        let home = Path::new("/Users/p");
        for path in [
            "/Users/p/.ssh/id_ed25519",
            "/Users/p/.aws/credentials",
            "/Users/p/.config/gh/hosts.yml",
            "/Users/p/.codex/auth.json",
            "/Users/p/.claude/.credentials.json",
            "/Users/p/.claude.json",
            "/Users/p/.cargo/credentials.toml",
            "/Users/p/.docker/config.json",
            "/Users/p/Library/Keychains/login.keychain-db",
            "/Library/Keychains/System.keychain",
        ] {
            assert!(denied(home, Path::new(path)), "{path}");
        }
    }

    #[test]
    fn toolchains_and_projects_beside_them_are_not() {
        let home = Path::new("/Users/p");
        for path in [
            "/Users/p/.cargo/bin/cargo",
            "/Users/p/.cargo/registry",
            "/Users/p/.docker/cli-plugins",
            "/Users/p/code/app/.ssh-notes.md",
            "/Users/p/.config/git/config",
        ] {
            assert!(!denied(home, Path::new(path)), "{path}");
        }
    }
}
