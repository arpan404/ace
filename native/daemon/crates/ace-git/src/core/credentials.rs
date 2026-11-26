// SPDX-License-Identifier: Apache-2.0
//! Credential helper sources from the person's own configuration
//! (`packages/git/src/credential-helpers.ts`, G2c): helpers and
//! `core.sshCommand` values from their system, XDG and global files only, never
//! from a file inside the checkout, its Git directory or a protected root.

use std::path::Path;

use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;
use crate::core::spawn::BoxFuture;

/// A credential helper exactly as Git names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialHelper {
    pub key: String,
    pub value: String,
}

/// One `git config` answer the checks read.
#[derive(Debug, Clone)]
pub struct ConfigOutput {
    pub stdout: Vec<u8>,
    pub exit_code: i32,
    pub truncated: bool,
}

/// The port that runs one `git config` query; every argument list is Git's own.
pub trait TransportQuery: Send + Sync {
    fn query(&self, args: &[String]) -> BoxFuture<'_, Result<ConfigOutput, GitError>>;
}

fn malformed(message: &str) -> GitError {
    GitError::new(GitErrorCode::MalformedOutput, message)
}

/// The `-z` field values Git printed, refusing anything but a terminated listing.
pub fn values(output: &ConfigOutput) -> Result<Vec<String>, GitError> {
    if output.truncated {
        return Err(GitError::new(
            GitErrorCode::OutputTooLarge,
            "Credential helper configuration is too large",
        ));
    }
    if output.exit_code != 0 && output.exit_code != 1 {
        return Err(GitError::new(
            GitErrorCode::GitFailed,
            "Could not inspect user credential helper configuration",
        ));
    }
    let text = std::str::from_utf8(&output.stdout).map_err(|_| {
        GitError::new(
            GitErrorCode::MalformedOutput,
            "Invalid credential helper configuration encoding",
        )
    })?;
    if text.is_empty() {
        return Ok(Vec::new());
    }
    if output.exit_code != 0 || !text.ends_with('\0') {
        return Err(malformed("Invalid credential helper configuration"));
    }
    Ok(text[..text.len() - 1]
        .split('\0')
        .map(str::to_owned)
        .collect())
}

/// Groups of `size` NUL-terminated fields, e.g. origin and value from `--show-origin`.
pub fn records(output: &ConfigOutput, size: usize) -> Result<Vec<Vec<String>>, GitError> {
    let fields = values(output)?;
    if size == 0 || !fields.len().is_multiple_of(size) {
        return Err(malformed("Invalid user transport configuration"));
    }
    Ok(fields.chunks(size).map(<[String]>::to_vec).collect())
}

/// Paths that may not supply transport programs, canonical.
pub struct TrustedOrigin {
    roots: Vec<Option<String>>,
}

impl TrustedOrigin {
    pub fn new(untrusted_roots: &[String]) -> Self {
        Self {
            roots: untrusted_roots
                .iter()
                .map(|root| paths::canonical(root).ok())
                .collect(),
        }
    }

    /// Whether `origin` is a file outside every untrusted root, following symbolic links.
    pub fn trusted(&self, origin: Option<&str>) -> bool {
        let Some(path) = origin.and_then(|origin| origin.strip_prefix("file:")) else {
            return false;
        };
        if !Path::new(path).is_absolute() {
            return false;
        }
        let Ok(resolved) = paths::canonical(path) else {
            return false;
        };
        let separator = std::path::MAIN_SEPARATOR;
        self.roots.iter().all(|root| match root {
            None => true,
            Some(root) => resolved != *root && !resolved.starts_with(&format!("{root}{separator}")),
        })
    }
}

/// The helper key's schema: `[^\0\n=]` refuses the `=` a `-c` key cannot carry.
fn helper_key_ok(key: &str) -> bool {
    static PATTERN: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    let pattern =
        PATTERN.get_or_init(|| regex::Regex::new(r"^credential\.(?:[^\x00\n=]+\.)?helper$").ok());
    // A zod bound counts code points; the key's is 4,096.
    key.chars().count() <= 4_096
        && pattern
            .as_ref()
            .is_some_and(|pattern| pattern.is_match(key))
}

fn helper_value_ok(value: &str) -> bool {
    // The value's bound is 16,384 code points.
    value.chars().count() <= 16_384 && !value.contains('\0')
}

/// The array's own `Helpers` schema: at most 512 entries, each key and value in bounds.
pub fn validate_helpers(helpers: Vec<CredentialHelper>) -> Result<Vec<CredentialHelper>, GitError> {
    if helpers.len() > 512
        || helpers
            .iter()
            .any(|helper| !helper_key_ok(&helper.key) || !helper_value_ok(&helper.value))
    {
        return Err(malformed("Invalid user credential helper configuration"));
    }
    Ok(helpers)
}

/// Helpers from one of the person's own config files, following its includes and `includeIf`
/// conditions (evaluated against the checkout the query runs in), as their own Git would.
pub async fn read_credential_helpers(
    query: &dyn TransportQuery,
    file: &str,
    trusted: &TrustedOrigin,
) -> Result<Vec<CredentialHelper>, GitError> {
    // A single query preserves generic/URL-scoped helpers and empty resets in file order.
    let output = query
        .query(&config_file_args(
            file,
            &["--get-regexp", r"^credential\.(.*\.)?helper$"],
        ))
        .await?;
    let mut ordered: Vec<CredentialHelper> = Vec::new();
    for entry in records(&output, 2)? {
        let (origin, value) = match entry.as_slice() {
            [origin, value] => (origin, value),
            _ => return Err(malformed("Invalid credential helper configuration")),
        };
        let Some(separator) = value.find('\n') else {
            return Err(malformed("Invalid credential helper configuration"));
        };
        if trusted.trusted(Some(origin)) {
            ordered.push(CredentialHelper {
                key: value[..separator].to_owned(),
                value: value[separator + 1..].to_owned(),
            });
        }
    }
    validate_helpers(ordered)
}

/// `core.sshCommand` values from one of the person's own files, under the same trust rule.
pub async fn read_ssh_commands(
    query: &dyn TransportQuery,
    file: &str,
    trusted: &TrustedOrigin,
) -> Result<Vec<String>, GitError> {
    let output = query
        .query(&config_file_args(file, &["--get-all", "core.sshCommand"]))
        .await?;
    Ok(records(&output, 2)?
        .into_iter()
        .filter(|entry| trusted.trusted(entry.first().map(String::as_str)))
        .filter_map(|entry| entry.get(1).cloned())
        .collect())
}

fn config_file_args(file: &str, tail: &[&str]) -> Vec<String> {
    let mut args = vec![
        "config".to_owned(),
        "--file".to_owned(),
        file.to_owned(),
        "--includes".to_owned(),
        "--show-origin".to_owned(),
        "--null".to_owned(),
    ];
    args.extend(tail.iter().map(|arg| (*arg).to_owned()));
    args
}

/// The repository's own `core.sshCommand` values (local and worktree scope), in Git's order.
pub async fn repository_ssh_commands(query: &dyn TransportQuery) -> Result<Vec<String>, GitError> {
    let output = query
        .query(&[
            "config".to_owned(),
            "--show-scope".to_owned(),
            "--null".to_owned(),
            "--get-all".to_owned(),
            "core.sshCommand".to_owned(),
        ])
        .await?;
    Ok(records(&output, 2)?
        .into_iter()
        .filter(|entry| {
            matches!(
                entry.first().map(String::as_str),
                Some("local" | "worktree")
            )
        })
        .filter_map(|entry| entry.get(1).cloned())
        .collect())
}

/// Git's compiled system file, pinned to system scope with includes disabled. Found by any key a
/// transfer borrows from it (a credential helper or `core.sshCommand`); a system file setting
/// neither has nothing to restore.
pub async fn system_credential_config_file(
    query: &dyn TransportQuery,
) -> Result<Option<String>, GitError> {
    let output = query
        .query(&[
            "config".to_owned(),
            "--system".to_owned(),
            "--no-includes".to_owned(),
            "--null".to_owned(),
            "--show-origin".to_owned(),
            "--name-only".to_owned(),
            "--get-regexp".to_owned(),
            r"^(credential\.(.*\.)?helper|core\.sshcommand)$".to_owned(),
        ])
        .await?;
    let entries = values(&output)?;
    let mut paths: Vec<String> = Vec::new();
    let mut index = 0;
    while index < entries.len() {
        let origin = entries.get(index).map(String::as_str);
        let key = entries.get(index + 1).map(String::as_str);
        index += 2;
        let (Some(origin), Some(key)) = (origin, key) else {
            return Err(malformed("Invalid system credential config origin"));
        };
        let path = origin
            .strip_prefix("file:")
            .filter(|path| !path.is_empty())
            .ok_or_else(|| malformed("Invalid system credential config origin"))?;
        if !(helper_key_ok(key) || key == "core.sshcommand") {
            return Err(malformed("Invalid system credential config origin"));
        }
        if !Path::new(path).is_absolute() {
            return Err(malformed("Invalid system credential config path"));
        }
        if !paths.iter().any(|known| known == path) {
            paths.push(path.to_owned());
        }
    }
    if paths.len() > 1 {
        return Err(malformed("Ambiguous system credential config origin"));
    }
    Ok(paths.into_iter().next())
}

/// Command configuration is read last: discard every inherited helper before restoring trust.
pub fn credential_helper_args(helpers: Vec<CredentialHelper>) -> Result<Vec<String>, GitError> {
    let mut args = vec![
        "-c".to_owned(),
        "credential.helper=".to_owned(),
        "-c".to_owned(),
        "core.askPass=".to_owned(),
    ];
    for helper in validate_helpers(helpers)? {
        args.push("-c".to_owned());
        args.push(format!("{}={}", helper.key, helper.value));
    }
    Ok(args)
}

#[cfg(test)]
pub(crate) mod test_support {
    //! A real Git for the (b) cases that need one: every query is a process in a temp home,
    //! never the person's configuration.

    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::{ConfigOutput, TransportQuery};
    use crate::core::error::{GitError, GitErrorCode};
    use crate::core::spawn::BoxFuture;

    static NEXT: AtomicU64 = AtomicU64::new(1);

    /// A fresh directory under the test temp root, removed by [`Fixture::drop`].
    pub(crate) struct Fixture {
        pub(crate) root: PathBuf,
        pub(crate) home: PathBuf,
    }

    impl Fixture {
        pub(crate) fn new(name: &str) -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("ace-git-g2c-{name}-{}-{id}", std::process::id()));
            let home = root.join("home");
            std::fs::create_dir_all(&home).expect("temp home");
            Self { root, home }
        }

        /// Runs Git and requires success, returning its stdout.
        pub(crate) fn git(&self, cwd: &Path, args: &[&str]) -> Vec<u8> {
            let output = self.command(cwd, &[]).args(args).output().expect("git");
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        }

        /// Creates a committed repository with the fixture files.
        pub(crate) fn repository(&self, name: &str) -> PathBuf {
            let repo = self.root.join(name);
            std::fs::create_dir_all(&repo).expect("repo");
            self.git(&repo, &["init", "--quiet"]);
            self.git(&repo, &["config", "user.email", "test@example.invalid"]);
            self.git(&repo, &["config", "user.name", "Test"]);
            std::fs::write(repo.join("file.txt"), "content\n").expect("file");
            self.git(&repo, &["add", "file.txt"]);
            self.git(&repo, &["commit", "--quiet", "-m", "initial"]);
            repo
        }

        /// A Git command with the fixture's isolated environment. The system file is a
        /// missing path under the fixture unless a caller points Git somewhere else, so no
        /// test reads the machine's own configuration.
        pub(crate) fn command(&self, cwd: &Path, env: &[(&str, &str)]) -> std::process::Command {
            let mut command = std::process::Command::new("git");
            command
                .current_dir(cwd)
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap_or_default())
                .env("HOME", &self.home)
                .env("XDG_CONFIG_HOME", self.home.join("xdg"))
                .env("GIT_CONFIG_SYSTEM", self.home.join("absent-system"))
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("LC_ALL", "C");
            for (key, value) in env {
                command.env(key, value);
            }
            command
        }
    }

    /// A Git config value that survives a path with spaces, quotes or a newline.
    pub(crate) fn quote_config(path: &Path) -> String {
        let mut out = String::from("\"");
        for character in path.to_string_lossy().chars() {
            match character {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\t' => out.push_str("\\t"),
                other => out.push(other),
            }
        }
        out.push('"');
        out
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).ok();
        }
    }

    /// A [`TransportQuery`] that answers a fixed sequence, for the malformed and absent cases.
    pub(crate) struct SequenceQuery(std::sync::Mutex<std::collections::VecDeque<ConfigOutput>>);

    impl SequenceQuery {
        pub(crate) fn new(answers: Vec<ConfigOutput>) -> Self {
            Self(std::sync::Mutex::new(answers.into()))
        }

        /// One `-z` listing as Git would print it.
        pub(crate) fn listing(text: &str) -> ConfigOutput {
            ConfigOutput {
                stdout: text.as_bytes().to_vec(),
                exit_code: 0,
                truncated: false,
            }
        }
    }

    impl TransportQuery for SequenceQuery {
        fn query(&self, _args: &[String]) -> BoxFuture<'_, Result<ConfigOutput, GitError>> {
            let next = self
                .0
                .lock()
                .ok()
                .and_then(|mut answers| answers.pop_front())
                .unwrap_or_else(|| Self::listing(""));
            Box::pin(async move { Ok(next) })
        }
    }

    /// A [`TransportQuery`] that runs real Git in a fixture checkout.
    pub(crate) struct GitQuery<'a> {
        pub(crate) fixture: &'a Fixture,
        pub(crate) cwd: &'a Path,
        pub(crate) env: &'a [(&'a str, &'a str)],
    }

    impl TransportQuery for GitQuery<'_> {
        fn query(&self, args: &[String]) -> BoxFuture<'_, Result<ConfigOutput, GitError>> {
            let args = args.to_vec();
            Box::pin(async move {
                let output = self
                    .fixture
                    .command(self.cwd, self.env)
                    .args(&args)
                    .output()
                    .map_err(|error| GitError::new(GitErrorCode::GitMissing, error.to_string()))?;
                Ok(ConfigOutput {
                    stdout: output.stdout,
                    exit_code: output.status.code().unwrap_or(-1),
                    truncated: false,
                })
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{Fixture, GitQuery, SequenceQuery, quote_config};
    use super::*;

    fn output(text: &str) -> ConfigOutput {
        ConfigOutput {
            stdout: text.as_bytes().to_vec(),
            exit_code: 0,
            truncated: false,
        }
    }

    #[test]
    fn values_refuse_truncation_bad_exits_and_unterminated_listings() {
        assert_eq!(
            records(&output("a\0b\0"), 2).ok(),
            Some(vec![vec!["a".to_owned(), "b".to_owned()]])
        );
        // An empty listing is no fields, not one empty field.
        assert_eq!(values(&output("")).ok(), Some(Vec::new()));
        assert_eq!(values(&output("\0")).ok(), Some(vec![String::new()]));
        let truncated = ConfigOutput {
            truncated: true,
            ..output("a\0")
        };
        assert_eq!(
            values(&truncated).err().map(|error| error.code),
            Some(GitErrorCode::OutputTooLarge)
        );
        for exit_code in [2, 128] {
            let failed = ConfigOutput {
                exit_code,
                ..output("a\0")
            };
            assert_eq!(
                values(&failed).err().map(|error| error.code),
                Some(GitErrorCode::GitFailed)
            );
        }
        // Git reports "no such key" with 1: a partial listing is malformed, not empty.
        let partial = ConfigOutput {
            exit_code: 1,
            ..output("a\0")
        };
        assert_eq!(
            values(&partial).err().map(|error| error.code),
            Some(GitErrorCode::MalformedOutput)
        );
        assert!(values(&output("a")).is_err());
        assert!(records(&output("a\0b\0c\0"), 2).is_err());
        let invalid = ConfigOutput {
            stdout: vec![0xff, 0xfe],
            exit_code: 0,
            truncated: false,
        };
        assert_eq!(
            values(&invalid).err().map(|error| error.code),
            Some(GitErrorCode::MalformedOutput)
        );
    }

    #[test]
    fn helper_keys_and_values_are_bounded_in_code_points_and_refuse_an_equals_sign() {
        // A zod bound counts code points: 4,096 code points is 8,174 UTF-16 units here.
        let longest = format!(
            "credential.{}.helper",
            "\u{1F600}".repeat(4_096 - "credential.".len() - ".helper".len())
        );
        assert_eq!(longest.chars().count(), 4_096);
        assert!(
            validate_helpers(vec![CredentialHelper {
                key: longest.clone(),
                value: "\u{1F600}".repeat(16_384),
            }])
            .is_ok()
        );
        let too_long = format!("{longest}\u{1F600}");
        assert!(
            validate_helpers(vec![CredentialHelper {
                key: too_long,
                value: String::new(),
            }])
            .is_err()
        );
        assert!(
            validate_helpers(vec![CredentialHelper {
                key: "credential.helper".to_owned(),
                value: "\u{1F600}".repeat(16_385),
            }])
            .is_err()
        );
        for key in [
            "credential..helper",
            "credential.a=b.helper",
            "credentialx.helper",
            "credential.a\n.helper",
            "credential.helper\n",
        ] {
            assert!(
                validate_helpers(vec![CredentialHelper {
                    key: key.to_owned(),
                    value: "x".to_owned(),
                }])
                .is_err(),
                "{key}"
            );
        }
        // A URL-scoped helper is a helper; the URL may carry `:` and `/`.
        for key in [
            "credential.http://127.0.0.1:8080/repo.git.helper",
            "credential.helper",
        ] {
            assert!(
                validate_helpers(vec![CredentialHelper {
                    key: key.to_owned(),
                    value: "!run".to_owned(),
                }])
                .is_ok(),
                "{key}"
            );
        }
        assert!(
            validate_helpers(vec![
                CredentialHelper {
                    key: "credential.helper".to_owned(),
                    value: "x".to_owned(),
                };
                513
            ])
            .is_err()
        );
        assert!(
            validate_helpers(vec![CredentialHelper {
                key: "credential.helper".to_owned(),
                value: "a\0b".to_owned(),
            }])
            .is_err()
        );
    }

    #[test]
    fn helper_args_reset_every_inherited_helper_before_restoring_trust() {
        assert_eq!(
            credential_helper_args(vec![CredentialHelper {
                key: "credential.https://example.invalid/.helper".to_owned(),
                value: "!run".to_owned(),
            }])
            .expect("args"),
            vec![
                "-c",
                "credential.helper=",
                "-c",
                "core.askPass=",
                "-c",
                "credential.https://example.invalid/.helper=!run",
            ]
        );
        // The schema is applied here too: a helper the caller built by hand cannot widen trust.
        assert!(
            credential_helper_args(vec![CredentialHelper {
                key: "credential.a=b.helper".to_owned(),
                value: "x".to_owned(),
            }])
            .is_err()
        );
    }

    #[tokio::test]
    async fn a_transfer_reads_only_helpers_outside_the_checkout_and_keeps_url_scope_and_order() {
        let fixture = Fixture::new("helpers");
        let repo = fixture.repository("repo with spaces\nand \u{96ea}");
        let home = fixture.root.clone();
        let inside = repo.join("planted.gitconfig");
        std::fs::write(
            &inside,
            "[credential]\n\thelper = planted\n\thelper = planted-too\n",
        )
        .expect("planted");
        let user = home.join("user.gitconfig");
        std::fs::write(
            &user,
            format!(
                "[credential]\n\thelper = generic\n[credential \"http://127.0.0.1:8080/repo.git\"]\n\thelper = scoped\n[include]\n\tpath = {}\n",
                quote_config(&inside)
            ),
        )
        .expect("user config");
        // The repository's own helper is never a file the transfer reads.
        fixture.git(&repo, &["config", "credential.helper", "repo-helper"]);

        let query = GitQuery {
            fixture: &fixture,
            cwd: &repo,
            env: &[],
        };
        let trusted = TrustedOrigin::new(&[repo.to_string_lossy().into_owned()]);
        let helpers = read_credential_helpers(&query, &user.to_string_lossy(), &trusted)
            .await
            .expect("helpers");
        assert_eq!(
            helpers,
            vec![
                CredentialHelper {
                    key: "credential.helper".to_owned(),
                    value: "generic".to_owned(),
                },
                CredentialHelper {
                    key: "credential.http://127.0.0.1:8080/repo.git.helper".to_owned(),
                    value: "scoped".to_owned(),
                },
            ]
        );
        // The planted file is inside the checkout, so its entries are dropped even through the
        // person's own include.
        assert!(!trusted.trusted(Some(&format!("file:{}", inside.display()))));
        assert!(trusted.trusted(Some(&format!("file:{}", user.display()))));
    }

    #[tokio::test]
    async fn an_ssh_command_follows_includes_under_the_same_trust_rule() {
        let fixture = Fixture::new("ssh");
        let repo = fixture.repository("repo");
        let outside = fixture.root.join("outside.gitconfig");
        std::fs::write(&outside, "[core]\n\tsshCommand = person-ssh\n").expect("outside");
        let person = fixture.root.join("person.gitconfig");
        std::fs::write(
            &person,
            format!(
                "[include]\n\tpath = {}\n[core]\n\tsshCommand = later-ssh\n",
                quote_config(&outside)
            ),
        )
        .expect("person");
        // The repository's own value counts only for a checkout no agent writes.
        fixture.git(&repo, &["config", "core.sshCommand", "repo-ssh"]);
        let query = GitQuery {
            fixture: &fixture,
            cwd: &repo,
            env: &[],
        };
        let trusted = TrustedOrigin::new(&[repo.to_string_lossy().into_owned()]);
        assert_eq!(
            read_ssh_commands(&query, &person.to_string_lossy(), &trusted)
                .await
                .expect("commands"),
            vec!["person-ssh".to_owned(), "later-ssh".to_owned()]
        );
        assert_eq!(
            repository_ssh_commands(&query)
                .await
                .expect("repo commands"),
            vec!["repo-ssh".to_owned()]
        );
    }

    #[tokio::test]
    async fn the_system_file_is_the_one_git_compiled_unless_it_sets_nothing_a_transfer_borrows() {
        let fixture = Fixture::new("system");
        let repo = fixture.repository("repo");
        let system = fixture.root.join("system.gitconfig");
        std::fs::write(&system, "[credential]\n\thelper = system-helper\n").expect("system");
        let path = system.to_string_lossy().into_owned();
        let query = GitQuery {
            fixture: &fixture,
            cwd: &repo,
            env: &[("GIT_CONFIG_SYSTEM", &path)],
        };
        assert_eq!(
            system_credential_config_file(&query)
                .await
                .expect("system file"),
            Some(path.clone())
        );
        std::fs::write(&system, "[core]\n\teditor = true\n").expect("unrelated system");
        assert_eq!(
            system_credential_config_file(&query).await.expect("none"),
            None
        );
    }

    #[tokio::test]
    async fn a_system_origin_that_is_not_one_absolute_file_is_malformed_output() {
        for (stdout, code) in [
            (
                "command:\0credential.helper\0",
                GitErrorCode::MalformedOutput,
            ),
            ("file:\0credential.helper\0", GitErrorCode::MalformedOutput),
            (
                "file:relative\0credential.helper\0",
                GitErrorCode::MalformedOutput,
            ),
            (
                "file:/a\0not-a-borrowed-key\0",
                GitErrorCode::MalformedOutput,
            ),
            (
                "file:/a\0credential.helper\0file:/b\0core.sshcommand\0",
                GitErrorCode::MalformedOutput,
            ),
            (
                "file:/a\0credential.a=b.helper\0",
                GitErrorCode::MalformedOutput,
            ),
        ] {
            let answers = SequenceQuery::new(vec![output(stdout)]);
            let error = system_credential_config_file(&answers)
                .await
                .expect_err(stdout);
            assert_eq!(error.code, code, "{stdout}");
        }
        let answers = SequenceQuery::new(vec![output(
            "file:/a\0credential.helper\0file:/a\0core.sshcommand\0",
        )]);
        assert_eq!(
            system_credential_config_file(&answers)
                .await
                .expect("same file"),
            Some("/a".to_owned())
        );
    }

    #[test]
    fn an_unresolvable_root_is_skipped_rather_than_blocking_every_origin() {
        // Node's realpath failure leaves the root undefined, which never matches, so a
        // checkout that vanished cannot block the person's own files.
        let trusted = TrustedOrigin::new(&["/nonexistent/ace-g2c/root".to_owned()]);
        assert!(!trusted.trusted(None));
        assert!(!trusted.trusted(Some("file:relative")));
        assert!(!trusted.trusted(Some("command:/a")));
        assert!(!trusted.trusted(Some("file:/nonexistent/file")));
        let file = std::env::temp_dir().join(format!("ace-git-g2c-trust-{}", std::process::id()));
        std::fs::write(&file, "").expect("file");
        assert!(trusted.trusted(Some(&format!("file:{}", file.display()))));
        std::fs::remove_file(&file).ok();
    }
}
