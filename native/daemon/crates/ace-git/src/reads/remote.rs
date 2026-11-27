// SPDX-License-Identifier: Apache-2.0
//! Remote URL normalisation, the publication remote and the remote's default branch
//! (`packages/git/src/remote-url.ts`, `publication-remote.ts`, `remote-default-branch.ts`,
//! G3d).
//!
//! Proof: every case of `remote-url.test.ts` moved here, and
//! `remote-default-branch.process` against real Git.

use serde::Serialize;

use crate::core::error::{GitError, GitErrorCode};
use crate::core::reviewer::{ecma_trim, js_whitespace};
use crate::reads::{Command, CommandPort, checked, text_output};

fn starts_with_ignore_ascii_case(haystack: &str, prefix: &str) -> bool {
    let hay = haystack.as_bytes();
    let pre = prefix.as_bytes();
    hay.len() >= pre.len() && hay[..pre.len()].eq_ignore_ascii_case(pre)
}

fn strip_url_query_fragment(path: &str) -> &str {
    let path = path.split('?').next().unwrap_or(path);
    path.split('#').next().unwrap_or(path)
}

/// Keys of network remotes outside the public forges carry this version, so an older daemon's
/// unversioned key never equals one of these.
pub const REMOTE_KEY_VERSION_PREFIX: &str = "v2:";

/// Hosts whose provider is fixed (`publicForgeHosts` in `@ace/protocol`).
pub const PUBLIC_FORGE_HOSTS: &[&str] = &[
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "codeberg.org",
    "origin.cursor.com",
];

fn is_public_forge(host: &str) -> bool {
    PUBLIC_FORGE_HOSTS.contains(&host)
}

/// Ports a scheme reaches by default; any other port is part of the repository's address.
fn default_port(scheme: &str) -> Option<&'static str> {
    match scheme {
        "ssh" | "git+ssh" | "ssh+git" => Some("22"),
        "git" => Some("9418"),
        "http" => Some("80"),
        "https" => Some("443"),
        _ => None,
    }
}

fn is_ssh_scheme(scheme: &str) -> bool {
    matches!(scheme, "ssh" | "git+ssh" | "ssh+git")
}

fn is_drive(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || bytes[2] == b'/' || bytes[2] == b'\\')
}

fn scheme_of(value: &str) -> Option<(&str, &str, &str)> {
    let index = value.find("://")?;
    let scheme = &value[..index];
    let valid = !scheme.is_empty()
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'));
    if !valid {
        return None;
    }
    let rest = &value[index + 3..];
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let path = &rest[authority_end..];
    Some((scheme, authority, path))
}

/// `[user@]host:path`, as Git reads it: no slash before the colon, and not a drive letter.
fn scp_of(value: &str) -> Option<(&str, &str)> {
    let colon = value.find(':')?;
    if value[..colon].contains('/') || value[..colon].contains('\\') {
        return None;
    }
    let authority = &value[..colon];
    let authority_ok = match authority.rsplit_once('@') {
        Some((user, host)) => {
            !user.is_empty() && !user.contains('/') && !host.is_empty() && !host.contains('/')
        }
        None => !authority.is_empty(),
    };
    if !authority_ok || is_drive(value) {
        return None;
    }
    Some((authority, &value[colon + 1..]))
}

/// The authority's host, lowercased, with its port unless that is the scheme's default.
fn address_of(authority: &str, scheme_default: Option<&str>) -> String {
    let host_port = match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    };
    let (raw, port) = match host_port.strip_prefix('[') {
        Some(rest) => match rest.split_once(']') {
            Some((host, tail)) => (host, tail.strip_prefix(':').unwrap_or("")),
            None => (host_port, ""),
        },
        None => match host_port.split_once(':') {
            Some((host, port)) => (host, port),
            None => (host_port, ""),
        },
    };
    let host = raw.to_ascii_lowercase();
    // `/^0+(?=\d)/`: drop leading zeros only while another digit follows, so `0` stays `0`.
    let bytes = port.as_bytes();
    let mut start = 0usize;
    while start + 1 < bytes.len() && bytes[start] == b'0' && bytes[start + 1].is_ascii_digit() {
        start += 1;
    }
    let port = &port[start..];
    if !port.is_empty() && Some(port) != scheme_default {
        format!("{host}:{port}")
    } else {
        host
    }
}

fn login_user(authority: &str) -> Option<&str> {
    let at = authority.rfind('@')?;
    Some(authority[..at].split(':').next().unwrap_or("")).filter(|user| !user.is_empty())
}

fn network_key(host: &str, path: &str) -> String {
    let mut trimmed = path
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_owned();
    if let Some(stripped) = trimmed.strip_suffix(".git") {
        trimmed = stripped.to_owned();
    }
    trimmed = trimmed.trim_end_matches('/').to_owned();
    if trimmed.is_empty() {
        host.to_owned()
    } else {
        format!("{host}/{trimmed}")
    }
}

fn home_key(host: &str, user: Option<&str>, path: &str) -> String {
    let (owner, rest) = match path.strip_prefix('~') {
        Some(rest) => match rest.find('/') {
            Some(index) => (&rest[..index], &rest[index..]),
            None => (rest, ""),
        },
        None => ("", path),
    };
    let owner = if owner.is_empty() {
        user.unwrap_or("")
    } else {
        owner
    };
    format!(
        "{REMOTE_KEY_VERSION_PREFIX}{}",
        network_key(host, &format!("~{owner}{rest}"))
    )
}

fn server_key(host: &str, path: &str) -> String {
    let key = network_key(host, path);
    if is_public_forge(host) {
        return key;
    }
    let rest = key.get(host.len() + 1..).unwrap_or("");
    if rest.starts_with('~') {
        format!("{REMOTE_KEY_VERSION_PREFIX}{host}//{rest}")
    } else {
        format!("{REMOTE_KEY_VERSION_PREFIX}{key}")
    }
}

fn resolve_posix(base: &str, path: &str) -> String {
    let joined = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{base}/{path}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

fn local_path(path: &str, base: &str) -> String {
    if is_drive(path) {
        let trimmed = path.trim_end_matches(['/', '\\']);
        let bytes = trimmed.as_bytes();
        if bytes.len() == 2 {
            return format!("{trimmed}/");
        }
        return trimmed.to_owned();
    }
    resolve_posix(base, path)
}

/// The path a `file://` URL names, percent-decoded; one that won't decode stays as written.
fn file_url_path(value: &str) -> String {
    let rest = value
        .as_bytes()
        .get(7..)
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .unwrap_or("");
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    let path = strip_url_query_fragment(path);
    let path = percent_decode(path).unwrap_or_else(|| path.to_owned());
    if path.len() >= 3 && is_drive(&path[1..]) {
        return path[1..].to_owned();
    }
    let host = authority.to_ascii_lowercase();
    if host.is_empty() || host == "localhost" {
        path
    } else {
        format!("//{host}{path}")
    }
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// One key for every spelling of the same repository.
pub fn normalize_remote_url(url: &str, base: &str) -> String {
    let value = url.trim();
    if starts_with_ignore_ascii_case(value, "file://") {
        return local_path(&file_url_path(value), base);
    }
    if let Some((scheme, authority, path)) = scheme_of(value) {
        let name = scheme.to_ascii_lowercase();
        let host = address_of(authority, default_port(&name));
        if is_ssh_scheme(&name) && !is_public_forge(&host) && path.starts_with("/~") {
            return home_key(&host, login_user(authority), &path[1..]);
        }
        return server_key(&host, path);
    }
    if is_drive(value) || value.starts_with('/') || value.starts_with('.') {
        return local_path(value, base);
    }
    if let Some((authority, path)) = scp_of(value) {
        let host = address_of(authority, None);
        if is_public_forge(&host) || path.starts_with('/') {
            return server_key(&host, path);
        }
        let user = value
            .split('@')
            .next()
            .filter(|_| value.contains('@') && !value.starts_with('@'));
        return home_key(
            &host,
            user,
            if path.starts_with('~') {
                path.to_owned()
            } else {
                format!("~/{path}")
            }
            .as_str(),
        );
    }
    local_path(value, base)
}

/// Whether a key names a path on this machine's own disk rather than a network address.
pub fn is_local_remote_key(key: &str) -> bool {
    if key.starts_with('/') || key.starts_with('\\') {
        return true;
    }
    let bytes = key.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || bytes[2] == b'/' || bytes[2] == b'\\')
}

/// The remote used by the daemon's repository discovery and PR publication.
pub fn publication_remote<T>(remotes: &[T], name: impl Fn(&T) -> &str) -> Option<&T> {
    remotes
        .iter()
        .find(|remote| name(remote) == "origin")
        .or_else(|| remotes.first())
}

/// Cross-remote PR creation is unsupported; a reviewed diff must target the publication remote.
pub fn assert_pr_base(reference: &str, branch: &str, remote: Option<&str>) -> Result<(), GitError> {
    if reference == format!("refs/heads/{branch}") {
        return Ok(());
    }
    if let Some(remote) = remote
        && reference == format!("refs/remotes/{remote}/{branch}")
    {
        return Ok(());
    }
    Err(GitError::new(
        GitErrorCode::PrBaseMismatch,
        "PR draft base must match the publication remote and target branch; cross-remote PR drafts are unsupported",
    ))
}

/// `ref: refs/heads/main<TAB>HEAD` from `ls-remote --symref`.
pub fn symref_head(output: &str) -> Option<String> {
    for line in output.split('\n') {
        let line = ecma_trim(line);
        let Some(rest) = line.strip_prefix("ref: refs/heads/") else {
            continue;
        };
        let Some((name, tail)) = rest.split_once('\t') else {
            continue;
        };
        if name.is_empty() || name.chars().any(js_whitespace) || tail != "HEAD" {
            continue;
        }
        return Some(name.to_owned());
    }
    None
}

/// The branch the remote's `HEAD` names, from `symbolic-ref` else one bounded `ls-remote`.
pub async fn remote_default_branch(
    port: &dyn CommandPort,
    root: &str,
    remote: &str,
    timeout_ms: u64,
) -> Result<Option<String>, GitError> {
    if timeout_ms == 0 || timeout_ms > 2_147_483_647 {
        return Ok(None);
    }
    let names = checked(port, Command::new(root, &["remote"])).await?;
    let known = text_output(&names.stdout)?;
    if !known.lines().any(|name| name == remote) {
        return Ok(None);
    }
    let recorded = checked(
        port,
        Command::new(
            root,
            &[
                "symbolic-ref",
                "--quiet",
                "--short",
                &format!("refs/remotes/{remote}/HEAD"),
            ],
        )
        .allowing_failure(),
    )
    .await?;
    if recorded.exit_code == 0 {
        let name = text_output(&recorded.stdout)?;
        if let Some(short) = name.strip_prefix(&format!("{remote}/"))
            && !short.is_empty()
        {
            return Ok(Some(short.to_owned()));
        }
    }
    let result = match checked(
        port,
        Command::new(
            root,
            &["ls-remote", "--symref", "--end-of-options", remote, "HEAD"],
        )
        .allowing_failure()
        .with_capture_bytes(65_536)
        .stopping_after(timeout_ms)
        .with_env(&[("GIT_TERMINAL_PROMPT", "0"), ("GCM_INTERACTIVE", "never")]),
    )
    .await
    {
        Ok(result) => result,
        Err(error) if error.code != GitErrorCode::GitClosed => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(if result.exit_code == 0 && result.stopped.is_none() {
        symref_head(&String::from_utf8_lossy(&result.stdout))
    } else {
        None
    })
}

/// One remote and its URLs, for the callers that take `RepositoryInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUrls {
    pub name: String,
    pub fetch_urls: Vec<String>,
    pub push_urls: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    fn same(left: &str, right: &str) -> bool {
        normalize_remote_url(left, "/") == normalize_remote_url(right, "/")
    }

    #[test]
    fn every_spelling_of_one_repository_keys_alike() {
        for (left, right) in [
            ("git@github.com:o/r.git", "ssh://git@github.com/o/r"),
            ("git@github.com:o/r", "https://github.com/o/r"),
            (
                "ssh://git@gitlab.com/group/app.git",
                "https://gitlab.com/group/app",
            ),
            (
                "git@bitbucket.org:team/app.git",
                "ssh://git@bitbucket.org/team/app",
            ),
            ("git@codeberg.org:o/r", "https://codeberg.org/o/r.git"),
            (
                "git@forge:/srv/team/app.git",
                "ssh://git@forge/srv/team/app",
            ),
            ("ssh://git@forge:22/team/app", "ssh://forge/team/app.git"),
            ("ssh://git@forge/team/app", "https://forge/team/app"),
            ("git@forge:team/app.git", "git@forge:~/team/app"),
            ("git@forge:team/app", "ssh://git@forge/~/team/app"),
            ("git@forge:team/app", "ssh://git@forge:22/~git/team/app.git"),
            ("git@forge:~bob/app", "ssh://alice@forge/~bob/app"),
            ("https://forge:443/team/app", "http://forge:80/team/app"),
            ("git@box:/~git/team/app.git", "ssh://git@box//~git/team/app"),
            ("git@box:/~git/team/app", "https://box/~git/team/app"),
        ] {
            assert!(same(left, right), "{left} vs {right}");
        }
    }

    #[test]
    fn different_repositories_keep_different_keys() {
        for (left, right) in [
            ("git@forge:team/app.git", "ssh://git@forge/team/app.git"),
            ("git@forge:team/app", "git@forge:/team/app"),
            ("ssh://git@forge/~/team/app", "ssh://git@forge/team/app"),
            ("git@forge:team/app", "https://forge/team/app"),
            ("git@box:team/app.git", "git@box:/~git/team/app.git"),
            (
                "ssh://git@box/~git/team/app",
                "ssh://git@box//~git/team/app",
            ),
            ("git@box:~bob/app", "https://box/~bob/app"),
            ("alice@forge:app", "bob@forge:app"),
            ("ssh://forge/~alice/app", "ssh://forge/~bob/app"),
            (
                "ssh://git@forge:2222/team/app.git",
                "ssh://git@forge:2223/team/app.git",
            ),
            (
                "ssh://git@forge:2222/team/app.git",
                "ssh://git@forge/team/app.git",
            ),
            ("ssh://git@[::1]:2222/team/app", "ssh://git@[::1]/team/app"),
            (
                "forge:2222/team/app.git",
                "ssh://git@forge:2222/team/app.git",
            ),
            (
                "https://forge:8443/team/app.git",
                "https://forge/team/app.git",
            ),
            ("git@github.com:o/r", "git@github.com:O/R"),
            ("git@github.com:o/r", "git@gitlab.com:o/r"),
        ] {
            assert!(!same(left, right), "{left} vs {right}");
        }
    }

    #[test]
    fn a_zero_port_is_kept_and_leading_zeros_are_stripped_only_before_a_digit() {
        // `:0` is a port and remains part of the address; `:00` normalises to the same `:0`.
        assert_eq!(
            normalize_remote_url("ssh://git@forge:0/team/app", "/"),
            "v2:forge:0/team/app"
        );
        assert_eq!(
            normalize_remote_url("ssh://git@forge:00/team/app", "/"),
            "v2:forge:0/team/app"
        );
        assert!(!same(
            "ssh://git@forge:0/team/app",
            "ssh://git@forge/team/app"
        ));
        // `:0022` is the scheme's default once its leading zeros go.
        assert_eq!(
            normalize_remote_url("ssh://git@forge:0022/team/app", "/"),
            "v2:forge/team/app"
        );
        assert_eq!(
            normalize_remote_url("ssh://git@forge:00022/team/app", "/"),
            "v2:forge/team/app"
        );
        // A non-default port keeps its remaining digits.
        assert_eq!(
            normalize_remote_url("ssh://git@forge:0022/team/app", "/"),
            normalize_remote_url("ssh://git@forge:22/team/app", "/")
        );
    }

    #[test]
    fn keys_outside_a_public_forge_are_versioned_and_public_forges_stay_as_they_were() {
        assert_eq!(
            normalize_remote_url("ssh://git@forge/team/app.git", "/"),
            "v2:forge/team/app"
        );
        assert_eq!(
            normalize_remote_url("git@forge:team/app.git", "/"),
            "v2:forge/~git/team/app"
        );
        assert_eq!(
            normalize_remote_url("git@forge:/~git/team/app.git", "/"),
            "v2:forge//~git/team/app"
        );
        assert_eq!(
            normalize_remote_url("git@github.com:o/r.git", "/"),
            "github.com/o/r"
        );
        assert_eq!(
            normalize_remote_url("/srv/git/app.git", "/"),
            "/srv/git/app.git"
        );
    }

    #[test]
    fn a_local_path_with_a_leading_emoji_does_not_panic_and_file_urls_ignore_queries() {
        let emoji_repo = "../\u{1F600}-repo";
        let _ = normalize_remote_url(emoji_repo, "/base");
        assert_eq!(
            normalize_remote_url("file:///tmp/repo?x=1#frag", "/"),
            "/tmp/repo"
        );
    }

    #[test]
    fn a_symref_head_branch_may_contain_ecmascript_non_separator_characters() {
        let branch = "br\u{0085}anch";
        assert_eq!(
            symref_head(&format!("ref: refs/heads/{branch}\tHEAD\n")),
            Some(branch.to_owned())
        );
    }

    #[test]
    fn local_paths_resolve_against_the_checkout_and_local_keys_are_told_from_network_ones() {
        assert_eq!(
            normalize_remote_url("../app.git", "/repos/ace"),
            "/repos/app.git"
        );
        assert_eq!(
            normalize_remote_url("file:///srv/git/app.git", "/"),
            "/srv/git/app.git"
        );
        assert_eq!(
            normalize_remote_url("file:///srv/app%20name.git", "/"),
            "/srv/app name.git"
        );
        assert_eq!(
            normalize_remote_url("file://server/share/app.git", "/"),
            "/server/share/app.git"
        );
        for key in ["/srv/app", "\\\\server\\share", "C:/repos/app", "c:\\repos"] {
            assert!(is_local_remote_key(key), "{key}");
        }
        for key in ["github.com/o/r", "v2:forge/~git/app", "box:2222/app"] {
            assert!(!is_local_remote_key(key), "{key}");
        }
    }

    #[test]
    fn the_publication_remote_prefers_origin_and_the_pr_base_must_name_it() {
        let remotes = [("upstream".to_owned(), "u"), ("origin".to_owned(), "o")];
        assert_eq!(
            publication_remote(&remotes, |remote| remote.0.as_str()).map(|remote| remote.1),
            Some("o")
        );
        assert_eq!(
            publication_remote(&remotes[..1], |remote| remote.0.as_str()).map(|remote| remote.1),
            Some("u")
        );
        assert!(assert_pr_base("refs/heads/main", "main", Some("origin")).is_ok());
        assert!(assert_pr_base("refs/remotes/origin/main", "main", Some("origin")).is_ok());
        assert_eq!(
            assert_pr_base("refs/remotes/upstream/main", "main", Some("origin"))
                .expect_err("cross-remote")
                .code,
            GitErrorCode::PrBaseMismatch
        );
    }

    #[test]
    fn a_symref_head_line_names_the_default_branch_and_nothing_else_does() {
        assert_eq!(
            symref_head("ref: refs/heads/main\tHEAD\nabc\tHEAD\n"),
            Some("main".to_owned())
        );
        assert_eq!(symref_head("abc\tHEAD\n"), None);
        assert_eq!(symref_head("ref: refs/heads/with space\tHEAD\n"), None);
    }

    #[tokio::test]
    async fn a_timeout_refused_or_capped_query_returns_unknown_and_git_closed_propagates() {
        use crate::core::spawn::BoxFuture;
        use crate::reads::{Command, CommandOutput, CommandPort};

        struct MockPort {
            error: Option<GitError>,
        }
        impl CommandPort for MockPort {
            fn run(&self, command: Command) -> BoxFuture<'_, Result<CommandOutput, GitError>> {
                Box::pin(async move {
                    if command.args.first().is_some_and(|arg| arg == "remote") {
                        Ok(CommandOutput {
                            stdout: b"origin\n".to_vec(),
                            stderr: String::new(),
                            exit_code: 0,
                            truncated: false,
                            stopped: None,
                        })
                    } else if command
                        .args
                        .first()
                        .is_some_and(|arg| arg == "symbolic-ref")
                    {
                        Ok(CommandOutput {
                            stdout: Vec::new(),
                            stderr: String::new(),
                            exit_code: 1,
                            truncated: false,
                            stopped: None,
                        })
                    } else if let Some(error) = &self.error {
                        Err(error.clone())
                    } else {
                        Ok(CommandOutput {
                            stdout: Vec::new(),
                            stderr: String::new(),
                            exit_code: 128,
                            truncated: false,
                            stopped: None,
                        })
                    }
                })
            }
        }
        let port = MockPort {
            error: Some(GitError::new(GitErrorCode::GitTimeout, "timeout")),
        };
        assert_eq!(
            remote_default_branch(&port, "/repo", "origin", 1_000)
                .await
                .expect("timeout"),
            None
        );
        let port = MockPort {
            error: Some(GitError::new(GitErrorCode::GitClosed, "closed")),
        };
        assert_eq!(
            remote_default_branch(&port, "/repo", "origin", 1_000)
                .await
                .expect_err("closed")
                .code,
            GitErrorCode::GitClosed
        );
        assert_eq!(
            remote_default_branch(&MockPort { error: None }, "/repo", "origin", 3_000_000_000)
                .await
                .expect("capped"),
            None
        );
        let port = MockPort { error: None };
        assert_eq!(
            remote_default_branch(&port, "/repo", "origin", 1_000)
                .await
                .expect("refused"),
            None
        );
    }

    #[tokio::test]
    async fn a_recorded_remote_head_is_the_default_branch_without_a_query() {
        let fixture = Fixture::new("g3d-default");
        let repo = fixture.repository("repo");
        fixture.git(
            &repo,
            &["remote", "add", "origin", "https://example.invalid/a.git"],
        );
        fixture.git(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        fixture.git(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        assert_eq!(
            remote_default_branch(&port, &root, "origin", 5_000)
                .await
                .expect("default"),
            Some("main".to_owned())
        );
        assert_eq!(
            remote_default_branch(&port, &root, "absent", 5_000)
                .await
                .expect("absent"),
            None
        );
        assert_eq!(
            remote_default_branch(&port, &root, "origin", 0)
                .await
                .expect("no timeout"),
            None
        );
    }
}
