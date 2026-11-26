// SPDX-License-Identifier: Apache-2.0
//! Command-scope settings for every Git call on a temporary index
//! (`packages/git/src/temporary-index.ts`, G2c): checkpoint capture, restore,
//! their discovery and collision checks. fsmonitor and the untracked cache
//! could answer for files without Git looking at them, and `core.ignoreStat`
//! marks every entry `read-tree` or `add` writes as assume-unchanged, so a
//! later edit to it is skipped.
//!
//! `removeIndexSubtrees` and `statusWithoutHidingFlags` stay in TypeScript until
//! G3b's index parser and the repository-state port exist; every setting and the
//! index environment they use are here.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::core::error::{GitError, GitErrorCode};

/// The switches every temporary-index call carries.
pub const TEMPORARY_INDEX_SETTINGS: &[(&str, &str)] = &[
    ("core.fsmonitor", "false"),
    ("core.untrackedCache", "false"),
    ("core.ignoreStat", "false"),
];

/// `GIT_CONFIG_PARAMETERS` quoting: single quotes, with any quote inside escaped.
fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Sets one environment entry, keeping its position when it is already there.
fn set_env(env: &mut Vec<(String, String)>, key: &str, value: String) {
    match env.iter_mut().find(|(name, _)| name == key) {
        Some(entry) => entry.1 = value,
        None => env.push((key.to_owned(), value)),
    }
}

/// `env` with one more command-scope setting after the ones it already carries.
pub fn with_setting(
    mut env: Vec<(String, String)>,
    key: &str,
    value: &str,
) -> Vec<(String, String)> {
    let setting = format!("{}={}", quoted(key), quoted(value));
    let current = env
        .iter()
        .find(|(name, _)| name == "GIT_CONFIG_PARAMETERS")
        .map(|(_, current)| current.clone());
    let next = match current {
        Some(current) if !current.is_empty() => format!("{current} {setting}"),
        _ => setting,
    };
    set_env(&mut env, "GIT_CONFIG_PARAMETERS", next);
    env
}

static NEXT_INDEX: AtomicU64 = AtomicU64::new(1);

/// A fresh temporary index: its directory, its environment and its cleanup.
///
/// The directory is created under the caller's root, carries `GIT_INDEX_FILE` at
/// `<directory>/index` and the three settings, and is removed when this drops.
pub struct TemporaryIndex {
    directory: PathBuf,
    env: Vec<(String, String)>,
}

impl TemporaryIndex {
    /// `mkdtemp(join(directoryRoot, "ace-git-index-"))` and the settings around it.
    pub fn create(directory_root: &str) -> Result<Self, GitError> {
        let mut attempts = 0;
        let directory = loop {
            let id = NEXT_INDEX.fetch_add(1, Ordering::Relaxed);
            let candidate = Path::new(directory_root)
                .join(format!("ace-git-index-{}-{id}", std::process::id()));
            match std::fs::create_dir(&candidate) {
                Ok(()) => break candidate,
                Err(error)
                    if error.kind() == std::io::ErrorKind::AlreadyExists && attempts < 16 =>
                {
                    attempts += 1;
                }
                Err(_) => {
                    return Err(GitError::new(
                        GitErrorCode::FilesystemError,
                        "Could not create a temporary index",
                    ));
                }
            }
        };
        let mut env = vec![(
            "GIT_INDEX_FILE".to_owned(),
            directory.join("index").to_string_lossy().into_owned(),
        )];
        for (key, value) in TEMPORARY_INDEX_SETTINGS {
            env = with_setting(env, key, value);
        }
        Ok(Self { directory, env })
    }

    /// The environment every call on this index runs with.
    pub fn env(&self) -> &[(String, String)] {
        &self.env
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }
}

impl Drop for TemporaryIndex {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.directory).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;

    fn value(env: &[(String, String)], key: &str) -> Option<String> {
        env.iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    }

    /// Runs Git with `env` in a fixture checkout.
    fn git_env(
        fixture: &Fixture,
        repo: &Path,
        env: &[(String, String)],
        args: &[&str],
    ) -> std::process::Output {
        let pairs: Vec<(&str, &str)> = env
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        fixture
            .command(repo, &pairs)
            .args(args)
            .output()
            .expect("git")
    }

    #[test]
    fn quoting_survives_a_quote_a_space_and_an_astral_character() {
        let fixture = Fixture::new("temp-index-quote");
        let repo = fixture.repository("repo");
        let env = with_setting(Vec::new(), "some.quotedKey", "a'b c\u{1F600} two");
        assert_eq!(
            value(&env, "GIT_CONFIG_PARAMETERS").as_deref(),
            Some("'some.quotedKey'='a'\\''b c\u{1F600} two'")
        );
        // Git itself is the proof the quoting is what it parses.
        let config = git_env(
            &fixture,
            &repo,
            &env,
            &["config", "--get", "some.quotedKey"],
        );
        assert!(config.status.success());
        assert_eq!(
            String::from_utf8_lossy(&config.stdout).trim_end(),
            "a'b c\u{1F600} two"
        );
    }

    #[test]
    fn a_setting_appends_after_the_ones_the_environment_already_carries() {
        let existing = vec![(
            "GIT_CONFIG_PARAMETERS".to_owned(),
            "'core.hooksPath'='/dev/null'".to_owned(),
        )];
        assert_eq!(
            value(
                &with_setting(existing, "core.fsmonitor", "false"),
                "GIT_CONFIG_PARAMETERS"
            )
            .as_deref(),
            Some("'core.hooksPath'='/dev/null' 'core.fsmonitor'='false'")
        );
        // An empty value is falsy in the TypeScript, so it starts the setting over.
        let empty = vec![("GIT_CONFIG_PARAMETERS".to_owned(), String::new())];
        assert_eq!(
            value(
                &with_setting(empty, "core.fsmonitor", "false"),
                "GIT_CONFIG_PARAMETERS"
            )
            .as_deref(),
            Some("'core.fsmonitor'='false'")
        );
    }

    #[test]
    fn a_temporary_index_is_a_fresh_directory_with_the_three_settings_and_gone_afterwards() {
        let fixture = Fixture::new("temp-index");
        let root = fixture.root.to_string_lossy().into_owned();
        let first = TemporaryIndex::create(&root).expect("first");
        let second = TemporaryIndex::create(&root).expect("second");
        assert_ne!(first.directory(), second.directory());
        assert!(first.directory().is_dir());
        assert!(
            first
                .directory()
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("ace-git-index-"))
        );
        assert_eq!(
            value(first.env(), "GIT_INDEX_FILE"),
            Some(
                first
                    .directory()
                    .join("index")
                    .to_string_lossy()
                    .into_owned()
            )
        );
        let parameters = value(first.env(), "GIT_CONFIG_PARAMETERS").expect("parameters");
        for (key, setting) in TEMPORARY_INDEX_SETTINGS {
            assert!(
                parameters.contains(&format!("'{key}'='{setting}'")),
                "{parameters}"
            );
        }
        let directory = first.directory().to_path_buf();
        drop(first);
        assert!(!directory.exists());
    }

    #[test]
    fn git_writes_only_the_temporary_index_the_environment_names() {
        let fixture = Fixture::new("temp-index-git");
        let repo = fixture.repository("repo");
        let index = TemporaryIndex::create(&fixture.root.to_string_lossy()).expect("index");
        std::fs::write(repo.join("temp-only.txt"), "temporary\n").expect("extra");
        let staged = git_env(
            &fixture,
            &repo,
            index.env(),
            &["update-index", "--add", "temp-only.txt"],
        );
        assert!(
            staged.status.success(),
            "{}",
            String::from_utf8_lossy(&staged.stderr)
        );
        // The temporary index sees the entry; the checkout's own index never does.
        let temporary = git_env(&fixture, &repo, index.env(), &["ls-files"]);
        assert!(String::from_utf8_lossy(&temporary.stdout).contains("temp-only.txt"));
        let own = fixture.git(&repo, &["ls-files"]);
        assert_eq!(String::from_utf8_lossy(&own).trim_end(), "file.txt");

        // And the three settings are in force for that call.
        for (key, setting) in TEMPORARY_INDEX_SETTINGS {
            let output = git_env(&fixture, &repo, index.env(), &["config", "--get", key]);
            assert_eq!(String::from_utf8_lossy(&output.stdout).trim_end(), *setting);
        }
    }
}
