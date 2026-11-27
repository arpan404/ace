// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! PR and issue URL parsing and canonical URL building (`pr-reference.ts`).

use std::collections::HashMap;

use regex::Regex;

use crate::pure::remote::repository_from_remote;
use crate::pure::{
    ForgeKind, ForgePrRef, ForgeRepository, ORIGIN_API_HOST, configured_forge, public_forge_host,
};
use crate::transport::error::{ForgeError, Kind};

/// A host entry a PR or issue URL may name (`PrHost`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrHost {
    Bare(String),
    Configured {
        host: String,
        forge: Option<ForgeKind>,
    },
}

impl PrHost {
    pub fn bare(host: impl Into<String>) -> PrHost {
        PrHost::Bare(host.into())
    }

    pub fn configured(host: impl Into<String>, forge: Option<ForgeKind>) -> PrHost {
        PrHost::Configured {
            host: host.into(),
            forge,
        }
    }
}

pub fn default_pr_hosts() -> Vec<PrHost> {
    vec![
        PrHost::bare("github.com"),
        PrHost::bare("gitlab.com"),
        PrHost::bare(ORIGIN_API_HOST),
    ]
}

enum HostProvider {
    Unlisted,
    Unknown,
    Known(ForgeKind),
}

fn host_provider(hosts: &[PrHost], hostname: &str) -> HostProvider {
    for entry in hosts {
        match entry {
            PrHost::Bare(h) if h.eq_ignore_ascii_case(hostname) => {
                return match public_forge_host(hostname) {
                    Some(k) => HostProvider::Known(k),
                    None => HostProvider::Unknown,
                };
            }
            PrHost::Configured { host, forge } if host.eq_ignore_ascii_case(hostname) => {
                return HostProvider::Known(configured_forge(hostname, *forge));
            }
            _ => {}
        }
    }
    HostProvider::Unlisted
}

/// Parses an HTTPS URL without credentials or port, returning `(hostname_lower, pathname)`.
fn parse_strict_https_url(value: &str) -> Result<(String, String), ForgeError> {
    let rest = value
        .strip_prefix("https://")
        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    let (authority, path_and_more) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    if authority.is_empty()
        || authority.contains('@')
        || authority.contains(':')
        || authority.chars().any(char::is_whitespace)
    {
        return Err(ForgeError::new(Kind::InvalidData));
    }
    let pathname = path_and_more
        .split(['?', '#'])
        .next()
        .unwrap_or(path_and_more);
    Ok((authority.to_ascii_lowercase(), pathname.to_owned()))
}

/// Parses an HTTPS pull/merge request URL (`prFromUrl`).
pub fn pr_from_url(value: &str, hosts: &[PrHost]) -> Result<ForgePrRef, ForgeError> {
    static ORIGIN_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^/codebase/([\w.-]+)/([\w.-]+)/pull/([1-9]\d*)/?$").expect("compiles")
    });
    static GITLAB_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^/(.+)/-/merge_requests/([1-9]\d*)/?$").expect("compiles")
    });
    static GITHUB_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^/([\w.-]+)/([\w.-]+)/pull/([1-9]\d*)(?:/(?:files|checks|commits))?/?$")
            .expect("compiles")
    });
    let (hostname, pathname) = parse_strict_https_url(value)?;
    if hostname == "cursor.com" {
        let caps = ORIGIN_RE
            .captures(&pathname)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let number = caps[3]
            .parse::<u64>()
            .map_err(|_| ForgeError::new(Kind::InvalidData))?;
        return Ok(ForgePrRef {
            repository: ForgeRepository::validate(
                ForgeKind::Origin,
                ORIGIN_API_HOST,
                &caps[1],
                &caps[2],
            )?,
            number,
        });
    }
    let provider = host_provider(hosts, &hostname);
    if matches!(provider, HostProvider::Unlisted) {
        return Err(ForgeError::new(Kind::InvalidData));
    }
    if let Some(caps) = GITLAB_RE.captures(&pathname)
        && matches!(
            provider,
            HostProvider::Known(ForgeKind::Gitlab) | HostProvider::Unknown
        )
    {
        let mut parts: Vec<&str> = caps[1].split('/').collect();
        let name = parts
            .pop()
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let number = caps[2]
            .parse::<u64>()
            .map_err(|_| ForgeError::new(Kind::InvalidData))?;
        return Ok(ForgePrRef {
            repository: ForgeRepository::validate(
                ForgeKind::Gitlab,
                hostname,
                parts.join("/"),
                name,
            )?,
            number,
        });
    }
    if let Some(caps) = GITHUB_RE.captures(&pathname)
        && matches!(
            provider,
            HostProvider::Known(ForgeKind::Github) | HostProvider::Unknown
        )
    {
        let number = caps[3]
            .parse::<u64>()
            .map_err(|_| ForgeError::new(Kind::InvalidData))?;
        return Ok(ForgePrRef {
            repository: ForgeRepository::validate(ForgeKind::Github, hostname, &caps[1], &caps[2])?,
            number,
        });
    }
    Err(ForgeError::new(Kind::InvalidData))
}

/// Resolves `owner/name`, `host/owner/name`, or GitLab `group/subgroup/name` relative to
/// `fallback` (`prRepository`).
pub fn pr_repository(
    value: &str,
    fallback: &ForgeRepository,
    hosts: &[PrHost],
) -> Result<ForgeRepository, ForgeError> {
    let parts: Vec<&str> = value.split('/').collect();
    if fallback.forge == ForgeKind::Gitlab
        && parts.len() >= 2
        && !parts[0].contains('.')
        && parts[0] != fallback.host
    {
        let owner = parts[..parts.len() - 1].join("/");
        let name = parts[parts.len() - 1];
        return ForgeRepository::validate(fallback.forge, fallback.host.clone(), owner, name);
    }
    if parts.len() != 2 && parts.len() != 3 {
        return Err(ForgeError::new(Kind::InvalidData));
    }
    let host = if parts.len() == 3 {
        parts[0].to_ascii_lowercase()
    } else {
        fallback.host.clone()
    };
    let owner = parts[parts.len() - 2];
    let name = parts[parts.len() - 1];
    if host == fallback.host {
        return ForgeRepository::validate(fallback.forge, host, owner, name);
    }
    let forge = match host_provider(hosts, &host) {
        HostProvider::Known(k) => Some(k),
        _ => public_forge_host(&host),
    }
    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    let mut map = HashMap::new();
    map.insert(host.clone(), forge);
    repository_from_remote(
        &format!("https://{host}/{owner}/{name}.git"),
        &map,
        &HashMap::new(),
    )
}

/// Canonical HTTPS web address built strictly from `pr`'s repository (`prUrl`).
pub fn pr_url(pr: &ForgePrRef) -> Result<String, ForgeError> {
    let repo = &pr.repository;
    if repo.forge == ForgeKind::Origin {
        return Ok(format!(
            "https://cursor.com/codebase/{}/{}/pull/{}",
            repo.owner, repo.name, pr.number
        ));
    }
    let segment = match repo.forge {
        ForgeKind::Github => "pull",
        ForgeKind::Gitlab => "-/merge_requests",
        ForgeKind::Gitea | ForgeKind::Forgejo => "pulls",
        ForgeKind::Bitbucket => "pull-requests",
        ForgeKind::Gitbucket => return Err(ForgeError::new(Kind::Unsupported)),
        ForgeKind::Origin => unreachable!(),
    };
    Ok(format!(
        "https://{}/{}/{}/{}/{}",
        repo.host, repo.owner, repo.name, segment, pr.number
    ))
}

/// Parses an HTTPS GitHub or GitLab issue URL (`issueFromUrl`).
pub fn issue_from_url(value: &str, hosts: &[PrHost]) -> Result<ForgePrRef, ForgeError> {
    static GITLAB_ISSUE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^/(.+)/-/issues/([1-9]\d*)/?$").expect("compiles")
    });
    static GITHUB_ISSUE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^/([\w.-]+)/([\w.-]+)/issues/([1-9]\d*)/?$").expect("compiles")
    });
    let (hostname, pathname) = parse_strict_https_url(value)?;
    if let Some(caps) = GITLAB_ISSUE.captures(&pathname) {
        let pr = pr_from_url(
            &format!(
                "https://{hostname}/{}/-/merge_requests/{}",
                &caps[1], &caps[2]
            ),
            hosts,
        )?;
        if pr.repository.forge != ForgeKind::Gitlab {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        return Ok(pr);
    }
    let Some(caps) = GITHUB_ISSUE.captures(&pathname) else {
        return Err(ForgeError::new(Kind::InvalidData));
    };
    if hostname != "github.com" {
        return Err(ForgeError::new(Kind::InvalidData));
    }
    pr_from_url(
        &format!(
            "https://{hostname}/{}/{}/pull/{}",
            &caps[1], &caps[2], &caps[3]
        ),
        &default_pr_hosts(),
    )
}

#[cfg(test)]
mod tests {
    use super::{PrHost, default_pr_hosts, issue_from_url, pr_from_url, pr_repository, pr_url};
    use crate::pure::{ForgeKind, ForgeRepository};
    use crate::transport::error::Kind;

    #[test]
    fn pr_from_url_handles_github_gitlab_origin_and_refuses_credentials() {
        let defaults = default_pr_hosts();
        let gh = pr_from_url("https://github.com/octo/ace/pull/42/files", &defaults).expect("gh");
        assert_eq!(gh.number, 42);
        assert_eq!(gh.repository.forge, ForgeKind::Github);
        assert_eq!(
            pr_url(&gh).expect("url"),
            "https://github.com/octo/ace/pull/42"
        );

        let gl = pr_from_url(
            "https://gitlab.com/org/sub/ace/-/merge_requests/9",
            &defaults,
        )
        .expect("gl");
        assert_eq!(gl.repository.owner, "org/sub");
        assert_eq!(
            pr_url(&gl).expect("url"),
            "https://gitlab.com/org/sub/ace/-/merge_requests/9"
        );

        let origin =
            pr_from_url("https://cursor.com/codebase/octo/ace/pull/7", &defaults).expect("origin");
        assert_eq!(origin.repository.forge, ForgeKind::Origin);
        assert_eq!(
            pr_url(&origin).expect("url"),
            "https://cursor.com/codebase/octo/ace/pull/7"
        );

        // Credentials, ports, and unlisted hosts are rejected.
        assert_eq!(
            pr_from_url("https://tok@github.com/octo/ace/pull/1", &defaults)
                .expect_err("creds")
                .kind,
            Kind::InvalidData
        );
        assert_eq!(
            pr_from_url("https://github.com:443/octo/ace/pull/1", &defaults)
                .expect_err("port")
                .kind,
            Kind::InvalidData
        );
        assert_eq!(
            pr_from_url("https://ghe.example/octo/ace/pull/1", &defaults)
                .expect_err("unlisted")
                .kind,
            Kind::InvalidData
        );
    }

    #[test]
    fn issue_from_url_and_pr_repository_work_across_hosts() {
        let hosts = vec![
            PrHost::bare("github.com"),
            PrHost::configured("gl.corp", Some(ForgeKind::Gitlab)),
        ];
        let issue =
            issue_from_url("https://gl.corp/team/sub/app/-/issues/15", &hosts).expect("gl issue");
        assert_eq!(issue.repository.forge, ForgeKind::Gitlab);
        assert_eq!(issue.repository.owner, "team/sub");
        assert_eq!(issue.number, 15);

        let fallback =
            ForgeRepository::validate(ForgeKind::Gitlab, "gl.corp", "team", "app").expect("repo");
        let nested = pr_repository("team/sub/other", &fallback, &hosts).expect("nested");
        assert_eq!(nested.owner, "team/sub");
        assert_eq!(nested.name, "other");
    }
}
