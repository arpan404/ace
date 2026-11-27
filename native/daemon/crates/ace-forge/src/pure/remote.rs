// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! Remote URL parsing and `git remote -v` repository detection (`remote.ts`, `detect.ts`).

use std::collections::HashMap;
use std::sync::Arc;

use regex::Regex;

use crate::pure::{ForgeKind, ForgeRepository, ORIGIN_API_HOST, public_forge_host};
use crate::transport::command::{Cancellation, CommandRequest, Mode, Runner};
use crate::transport::error::{ForgeError, Kind};

/// GitHub's documented SSH-over-HTTPS endpoint names the same host.
fn host_equivalent(host: &str) -> &str {
    match host {
        "ssh.github.com" => "github.com",
        other => other,
    }
}

/// Parses a git remote URL (SCP-like or `https:`/`ssh:`/`git:`) into a validated
/// [`ForgeRepository`], applying SSH host `aliases` and explicit `hosts` mappings.
pub fn repository_from_remote(
    remote: &str,
    hosts: &HashMap<String, ForgeKind>,
    aliases: &HashMap<String, String>,
) -> Result<ForgeRepository, ForgeError> {
    static SCP: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^(?:[\w.-]+@)?([\w.-]+):([^/].*)$").expect("compiles")
    });
    if remote.chars().count() > 4_096 {
        return Err(ForgeError::new(Kind::InvalidData));
    }
    let (mut host, mut path) = if !remote.contains("://")
        && let Some(caps) = SCP.captures(remote)
    {
        (caps[1].to_owned(), caps[2].to_owned())
    } else {
        let Some((scheme, rest)) = remote.split_once("://") else {
            return Err(ForgeError::new(Kind::Unsupported));
        };
        if !matches!(
            scheme.to_ascii_lowercase().as_str(),
            "https" | "ssh" | "git"
        ) {
            return Err(ForgeError::new(Kind::Unsupported));
        }
        let (authority, path_part) = match rest.find('/') {
            Some(idx) => (&rest[..idx], &rest[idx + 1..]),
            None => (rest, ""),
        };
        let host_port = match authority.rfind('@') {
            Some(idx) => &authority[idx + 1..],
            None => authority,
        };
        // Strip port if present (not IPv6 bracketed here; ForgeRepository rejects ':').
        let hostname = match host_port.split_once(':') {
            Some((h, _)) => h,
            None => host_port,
        };
        if hostname.is_empty() {
            return Err(ForgeError::new(Kind::Unsupported));
        }
        // Strip query/fragment as URL.pathname does.
        let pathname = path_part
            .split(['?', '#'])
            .next()
            .unwrap_or(path_part)
            .to_owned();
        (hostname.to_owned(), pathname)
    };
    host = host.to_ascii_lowercase();
    if let Some(resolved) = aliases.get(&host) {
        host = resolved.to_ascii_lowercase();
    }
    host = host_equivalent(&host).to_owned();
    let Some(forge) = public_forge_host(&host).or_else(|| hosts.get(&host).copied()) else {
        return Err(ForgeError::new(Kind::Unsupported));
    };
    if forge == ForgeKind::Origin && host != ORIGIN_API_HOST {
        return Err(ForgeError::new(Kind::Unsupported));
    }
    if forge == ForgeKind::Origin
        && let Some(stripped) = path.strip_prefix("git/")
    {
        path = stripped.to_owned();
    }
    let trimmed = path.strip_suffix('/').unwrap_or(&path);
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let mut parts: Vec<&str> = trimmed.split('/').collect();
    let Some(name) = parts.pop() else {
        return Err(ForgeError::new(Kind::Unsupported));
    };
    if forge != ForgeKind::Gitlab && parts.len() != 1 {
        return Err(ForgeError::new(Kind::Unsupported));
    }
    let owner = parts.join("/");
    ForgeRepository::validate(forge, host, owner, name)
        .map_err(|_| ForgeError::new(Kind::Unsupported))
}

/// Options for [`detect_repository`].
#[derive(Debug, Default)]
pub struct DetectOptions {
    pub remote: Option<String>,
    pub hosts: HashMap<String, ForgeKind>,
    pub aliases: HashMap<String, String>,
}

/// Runs `git remote -v` through `runner` and resolves the preferred remote (named, else
/// `origin`, else first fetch remote) to a [`ForgeRepository`].
pub async fn detect_repository(
    runner: &dyn Runner,
    cancellation: Option<Arc<Cancellation>>,
    options: &DetectOptions,
) -> Result<ForgeRepository, ForgeError> {
    static FETCH: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"^(\S+)\s+(\S+)\s+\(fetch\)$").expect("compiles"));
    let result = runner
        .run(CommandRequest {
            command: String::from("git"),
            args: vec![String::from("remote"), String::from("-v")],
            input: None,
            mode: Mode::Json,
            tail_bytes: None,
            cancellation,
            dispatch: None,
        })
        .await?;
    if result.code != Some(0) {
        return Err(ForgeError::new(Kind::Cli));
    }
    let remotes: Vec<(&str, &str)> = result
        .stdout
        .split('\n')
        .filter_map(|line| {
            let caps = FETCH.captures(line.trim())?;
            Some((caps.get(1)?.as_str(), caps.get(2)?.as_str()))
        })
        .collect();
    let chosen = if let Some(wanted) = &options.remote {
        remotes.iter().find(|(name, _)| *name == wanted.as_str())
    } else {
        remotes
            .iter()
            .find(|(name, _)| *name == "origin")
            .or_else(|| remotes.first())
    };
    let Some((_, url)) = chosen else {
        return Err(ForgeError::new(Kind::NotFound));
    };
    repository_from_remote(url, &options.hosts, &options.aliases)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::pin::Pin;

    use super::{DetectOptions, detect_repository, repository_from_remote};
    use crate::pure::ForgeKind;
    use crate::transport::command::{CommandRequest, CommandResult, Runner};
    use crate::transport::error::{ForgeError, Kind};

    struct FakeGit(String, Option<i32>);

    impl Runner for FakeGit {
        fn credential_environment(&self) -> Option<ace_redaction::EnvironmentMatcher> {
            None
        }

        fn run<'a>(
            &'a self,
            _request: CommandRequest,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<CommandResult, ForgeError>> + Send + 'a>>
        {
            Box::pin(async move {
                Ok(CommandResult {
                    code: self.1,
                    stdout: self.0.clone(),
                    truncated: false,
                    identity_changed: false,
                    http: None,
                    unreachable: false,
                })
            })
        }
    }

    #[test]
    fn parses_https_ssh_scp_aliases_subgroups_and_origin() {
        let hosts = HashMap::new();
        let no_aliases = HashMap::new();
        let gh = repository_from_remote("git@github.com:Octo/Ace.git", &hosts, &no_aliases)
            .expect("github scp");
        assert_eq!(gh.forge, ForgeKind::Github);
        assert_eq!(gh.host, "github.com");
        assert_eq!(gh.owner, "Octo");
        assert_eq!(gh.name, "Ace");

        let ssh_alt = repository_from_remote(
            "ssh://git@ssh.github.com:443/octo/ace.git",
            &hosts,
            &no_aliases,
        )
        .expect("ssh.github.com");
        assert_eq!(ssh_alt.host, "github.com");

        let gl = repository_from_remote(
            "https://gitlab.com/org/team/sub/repo.git",
            &hosts,
            &no_aliases,
        )
        .expect("gitlab subgroups");
        assert_eq!(gl.forge, ForgeKind::Gitlab);
        assert_eq!(gl.owner, "org/team/sub");
        assert_eq!(gl.name, "repo");

        let origin = repository_from_remote(
            "https://origin.cursor.com/git/octo/ace.git",
            &hosts,
            &no_aliases,
        )
        .expect("origin");
        assert_eq!(origin.forge, ForgeKind::Origin);
        assert_eq!(origin.owner, "octo");
        assert_eq!(origin.name, "ace");

        let mut aliases = HashMap::new();
        aliases.insert(String::from("work-gh"), String::from("github.com"));
        let aliased =
            repository_from_remote("git@work-gh:octo/ace.git", &hosts, &aliases).expect("alias");
        assert_eq!(aliased.host, "github.com");

        // Self-hosted requires explicit mapping; traversal and http:// are refused.
        assert_eq!(
            repository_from_remote("https://git.corp.example/octo/ace.git", &hosts, &no_aliases)
                .expect_err("unmapped")
                .kind,
            Kind::Unsupported
        );
        assert_eq!(
            repository_from_remote("http://github.com/octo/ace.git", &hosts, &no_aliases)
                .expect_err("http")
                .kind,
            Kind::Unsupported
        );
        assert_eq!(
            repository_from_remote("https://github.com/octo/../ace.git", &hosts, &no_aliases)
                .expect_err("traversal")
                .kind,
            Kind::Unsupported
        );
    }

    #[test]
    fn detect_repository_picks_origin_or_named_remote() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("rt");
        let git = FakeGit(
            String::from(
                "upstream\thttps://github.com/up/repo.git (fetch)\n\
                 origin\tgit@github.com:me/repo.git (fetch)\n\
                 origin\tgit@github.com:me/repo.git (push)\n",
            ),
            Some(0),
        );
        rt.block_on(async {
            let repo = detect_repository(&git, None, &DetectOptions::default())
                .await
                .expect("origin");
            assert_eq!(repo.owner, "me");
            let up = detect_repository(
                &git,
                None,
                &DetectOptions {
                    remote: Some(String::from("upstream")),
                    ..DetectOptions::default()
                },
            )
            .await
            .expect("upstream");
            assert_eq!(up.owner, "up");
        });
    }
}
