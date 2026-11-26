// SPDX-License-Identifier: Apache-2.0
//! What an admitted transfer may borrow from the person's configuration
//! (`packages/git/src/transport-config.ts`, G2c): their credential helpers and
//! SSH command from their own files (system, XDG, global; includes followed),
//! never from a file inside the checkout, its Git directory or a protected
//! root. The checkout's own `core.sshCommand` counts only where no agent or PR
//! author writes.

use std::path::Path;

use crate::core::credentials::{self, ConfigOutput, CredentialHelper, GitQuery, TrustedOrigin};
use crate::core::error::{GitError, GitErrorCode};

/// One `rev-parse` path value: strip one LF terminator (CRLF only on Windows).
pub fn single_path(output: &ConfigOutput, is_windows: bool) -> Option<String> {
    if output.exit_code != 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if is_windows && text.ends_with("\r\n") {
        return Some(text[..text.len() - 2].to_owned());
    }
    if text.ends_with('\n') {
        return Some(text[..text.len() - 1].to_owned());
    }
    Some(text)
}

/// The checkout's working tree and Git common directory, as absolute paths.
async fn checkout_roots(query: &dyn GitQuery, is_windows: bool) -> Result<Vec<String>, GitError> {
    let mut roots: Vec<String> = Vec::new();
    for flag in ["--show-toplevel", "--git-common-dir"] {
        let output = query
            .query(&[
                "rev-parse".to_owned(),
                "--path-format=absolute".to_owned(),
                flag.to_owned(),
            ])
            .await?;
        // One path per invocation. Non-UTF-8 keeps proceeding as before (no new throw);
        // valid UTF-8 strips one terminator, CRLF only on Windows.
        let path = single_path(&output, is_windows);
        match path {
            Some(path) if Path::new(&path).is_absolute() && !output.truncated => roots.push(path),
            _ if flag == "--git-common-dir" => {
                return Err(GitError::new(
                    GitErrorCode::NotARepo,
                    "Could not locate the repository for a transfer",
                ));
            }
            _ => {}
        }
    }
    Ok(roots)
}

/// `stat` as `transport-config.ts` reads it: absence is not an error, anything else is.
fn present(file: &str) -> Result<bool, GitError> {
    match std::fs::metadata(file) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(GitError::new(
            GitErrorCode::FilesystemError,
            "Could not read user credential config file",
        )),
    }
}

/// One `userTransportConfig` call: the person's files in Git's own order.
#[derive(Debug, Clone)]
pub struct TransportOptions<'a> {
    /// The system, XDG and global files, once the caller has resolved them.
    pub files: &'a [Option<String>],
    pub protected_roots: &'a [String],
    pub helpers: bool,
    pub repository_ssh: bool,
    pub is_windows: bool,
}

/// What a transfer may use.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TransportConfig {
    pub helpers: Vec<CredentialHelper>,
    pub ssh_command: Option<String>,
}

pub async fn user_transport_config(
    query: &dyn GitQuery,
    options: &TransportOptions<'_>,
) -> Result<TransportConfig, GitError> {
    let mut roots = checkout_roots(query, options.is_windows).await?;
    roots.extend(options.protected_roots.iter().cloned());
    let trusted = TrustedOrigin::new(&roots);
    let mut helpers: Vec<CredentialHelper> = Vec::new();
    let mut commands: Vec<String> = Vec::new();
    for file in options.files.iter().flatten() {
        if !present(file)? {
            continue;
        }
        if options.helpers {
            helpers.extend(credentials::read_credential_helpers(query, file, &trusted).await?);
        }
        commands.extend(credentials::read_ssh_commands(query, file, &trusted).await?);
    }
    if options.repository_ssh {
        commands.extend(credentials::repository_ssh_commands(query).await?);
    }
    // Git's last value wins; an empty value means plain ssh again.
    Ok(TransportConfig {
        helpers,
        ssh_command: commands
            .last()
            .filter(|command| !command.is_empty())
            .cloned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::{
        Fixture, ProcessQuery, SequenceQuery, quote_config,
    };

    fn rev_parse(path: &str) -> ConfigOutput {
        ConfigOutput {
            stdout: format!("{path}\n").into_bytes(),
            exit_code: 0,
            truncated: false,
        }
    }

    #[test]
    fn a_rev_parse_path_strips_one_terminator_and_only_windows_strips_crlf() {
        let output = |text: &[u8]| ConfigOutput {
            stdout: text.to_vec(),
            exit_code: 0,
            truncated: false,
        };
        assert_eq!(
            single_path(&output(b"/a/b\n"), false).as_deref(),
            Some("/a/b")
        );
        assert_eq!(
            single_path(&output(b"/a/b\r\n"), false).as_deref(),
            Some("/a/b\r")
        );
        assert_eq!(
            single_path(&output(b"/a/b\r\n"), true).as_deref(),
            Some("/a/b")
        );
        assert_eq!(
            single_path(&output(b"/a/b"), false).as_deref(),
            Some("/a/b")
        );
        // A path may itself end in a newline: only Git's terminator goes.
        assert_eq!(
            single_path(&output(b"/a b\nc\n"), false).as_deref(),
            Some("/a b\nc")
        );
        // Non-UTF-8 is replacement, not an error, exactly as `toString("utf8")` reads it.
        assert_eq!(
            single_path(&output(b"/a/\xff"), false).as_deref(),
            Some("/a/\u{FFFD}")
        );
        let failed = ConfigOutput {
            exit_code: 1,
            ..output(b"/a/b\n")
        };
        assert_eq!(single_path(&failed, false), None);
    }

    #[tokio::test]
    async fn a_common_directory_that_is_absent_or_relative_is_not_a_repo() {
        for common in [
            ConfigOutput {
                exit_code: 1,
                ..rev_parse("/repo/.git")
            },
            rev_parse("relative/.git"),
            ConfigOutput {
                truncated: true,
                ..rev_parse("/repo/.git")
            },
        ] {
            let query = SequenceQuery::new(vec![rev_parse("/repo"), common]);
            let error = user_transport_config(
                &query,
                &TransportOptions {
                    files: &[],
                    protected_roots: &[],
                    helpers: true,
                    repository_ssh: true,
                    is_windows: false,
                },
            )
            .await
            .expect_err("no repository");
            assert_eq!(error.code, GitErrorCode::NotARepo);
        }
        // A missing working tree alone is not fatal: only the common directory is required.
        let query = SequenceQuery::new(vec![
            ConfigOutput {
                exit_code: 1,
                ..rev_parse("")
            },
            rev_parse("/repo/.git"),
        ]);
        user_transport_config(
            &query,
            &TransportOptions {
                files: &[],
                protected_roots: &[],
                helpers: true,
                repository_ssh: false,
                is_windows: false,
            },
        )
        .await
        .expect("common directory");
    }

    #[test]
    fn a_stat_that_fails_for_any_reason_but_absence_is_a_filesystem_error() {
        let fixture = Fixture::new("present");
        let file = fixture.root.join("plain");
        std::fs::write(&file, "").expect("file");
        assert!(present(&file.to_string_lossy()).expect("present"));
        assert!(!present(&fixture.root.join("absent").to_string_lossy()).expect("absent"));
        // A path below a regular file fails with ENOTDIR, which is not absence.
        let error = present(&file.join("child").to_string_lossy()).expect_err("not a directory");
        assert_eq!(error.code, GitErrorCode::FilesystemError);
    }

    #[tokio::test]
    async fn a_checkout_ssh_command_wins_only_where_no_agent_writes_the_checkout() {
        let fixture = Fixture::new("checkout-ssh");
        let repo = fixture.repository("repo");
        let global = fixture.root.join("global.gitconfig");
        std::fs::write(&global, "[core]\n\tsshCommand = global-ssh\n").expect("global");
        fixture.git(&repo, &["config", "core.sshCommand", "repo-ssh"]);
        let query = ProcessQuery {
            fixture: &fixture,
            cwd: &repo,
            env: &[],
        };
        let files = [Some(global.to_string_lossy().into_owned())];
        let roots = [repo.to_string_lossy().into_owned()];
        let settings = |repository_ssh| TransportOptions {
            files: &files,
            protected_roots: &roots,
            helpers: true,
            repository_ssh,
            is_windows: false,
        };
        // A checkout no agent or PR author writes may supply its own command.
        let person = user_transport_config(&query, &settings(true))
            .await
            .expect("person");
        assert_eq!(person.ssh_command.as_deref(), Some("repo-ssh"));
        // A protected one never can; the person's global command is used instead.
        let protected = user_transport_config(&query, &settings(false))
            .await
            .expect("protected");
        assert_eq!(protected.ssh_command.as_deref(), Some("global-ssh"));
    }

    #[tokio::test]
    async fn a_helper_from_an_included_file_for_this_checkout_is_used_but_one_inside_it_is_not() {
        let fixture = Fixture::new("includes");
        let repo = fixture.repository("repo");
        let outside = fixture.root.join("outside.gitconfig");
        std::fs::write(&outside, "[credential]\n\thelper = outside-helper\n").expect("outside");
        let global = fixture.root.join("user.gitconfig");
        std::fs::write(
            &global,
            format!("[include]\n\tpath = {}\n", quote_config(&outside)),
        )
        .expect("global");
        let query = ProcessQuery {
            fixture: &fixture,
            cwd: &repo,
            env: &[],
        };
        let files = [Some(global.to_string_lossy().into_owned())];
        let roots = [repo.to_string_lossy().into_owned()];
        let settings = || TransportOptions {
            files: &files,
            protected_roots: &roots,
            helpers: true,
            repository_ssh: false,
            is_windows: false,
        };
        let trusted = user_transport_config(&query, &settings())
            .await
            .expect("settings");
        assert_eq!(
            trusted.helpers,
            vec![CredentialHelper {
                key: "credential.helper".to_owned(),
                value: "outside-helper".to_owned(),
            }]
        );

        for relative in ["planted.gitconfig", ".git/planted.gitconfig"] {
            let inside = repo.join(relative);
            std::fs::write(&inside, "[credential]\n\thelper = planted-helper\n").expect("planted");
            std::fs::write(
                &global,
                format!("[include]\n\tpath = {}\n", quote_config(&inside)),
            )
            .expect("global");
            let planted = user_transport_config(&query, &settings())
                .await
                .expect("settings");
            assert!(planted.helpers.is_empty(), "{relative}");
        }
    }

    #[tokio::test]
    async fn an_absent_optional_file_is_skipped_and_the_last_ssh_value_wins() {
        let fixture = Fixture::new("order");
        let repo = fixture.repository("repo");
        let first = fixture.root.join("first.gitconfig");
        let second = fixture.root.join("second.gitconfig");
        std::fs::write(
            &first,
            "[core]\n\tsshCommand = first-ssh\n[credential]\n\thelper = first-helper\n",
        )
        .expect("first");
        std::fs::write(&second, "[core]\n\tsshCommand =\n").expect("second");
        let query = ProcessQuery {
            fixture: &fixture,
            cwd: &repo,
            env: &[],
        };
        let files = [
            None,
            Some(fixture.root.join("absent").to_string_lossy().into_owned()),
            Some(first.to_string_lossy().into_owned()),
            Some(second.to_string_lossy().into_owned()),
        ];
        let options = |repository_ssh| TransportOptions {
            files: &files,
            protected_roots: &[],
            helpers: true,
            repository_ssh,
            is_windows: false,
        };
        // The last value wins; an empty one means plain ssh again, not the earlier value.
        let person = user_transport_config(&query, &options(false))
            .await
            .expect("settings");
        assert_eq!(person.ssh_command, None);
        assert_eq!(person.helpers.len(), 1);
        // A repository command is read last, so it wins where it may be used.
        fixture.git(&repo, &["config", "core.sshCommand", "repo-ssh"]);
        let repository = user_transport_config(&query, &options(true))
            .await
            .expect("repository");
        assert_eq!(repository.ssh_command.as_deref(), Some("repo-ssh"));
    }
}
