// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! Pure forge helpers (F6 of docs/forge/porting-guide.md): remote parsing, PR/issue URLs,
//! project repository resolution, host capabilities, review anchors/hunks/draft moves,
//! suggestions, stack planning/publication and issue write planning.

pub mod capabilities;
pub mod draft_move;
pub mod issue_write_plan;
pub mod pr_reference;
pub mod project_repositories;
pub mod remote;
pub mod review;
pub mod stack_plan;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::transport::error::{ForgeError, Kind};

/// The part name the probe uses.
pub const PART: &str = "pure";

/// Cursor Origin's only hosted API host (`originApiHost`).
pub const ORIGIN_API_HOST: &str = "origin.cursor.com";

/// Supported forge kinds (`ForgeKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ForgeKind {
    Github,
    Gitlab,
    Gitbucket,
    Bitbucket,
    Gitea,
    Forgejo,
    Origin,
}

impl<'de> Deserialize<'de> for ForgeKind {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        ForgeKind::parse_str(&s)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown forge kind: {s}")))
    }
}

impl ForgeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ForgeKind::Github => "github",
            ForgeKind::Gitlab => "gitlab",
            ForgeKind::Gitbucket => "gitbucket",
            ForgeKind::Bitbucket => "bitbucket",
            ForgeKind::Gitea => "gitea",
            ForgeKind::Forgejo => "forgejo",
            ForgeKind::Origin => "origin",
        }
    }

    pub fn parse_str(value: &str) -> Option<ForgeKind> {
        match value {
            "github" => Some(ForgeKind::Github),
            "gitlab" => Some(ForgeKind::Gitlab),
            "gitbucket" => Some(ForgeKind::Gitbucket),
            "bitbucket" => Some(ForgeKind::Bitbucket),
            "gitea" => Some(ForgeKind::Gitea),
            "forgejo" => Some(ForgeKind::Forgejo),
            "origin" => Some(ForgeKind::Origin),
            _ => None,
        }
    }

    /// Providers ace can read pull requests from (`readableForges`).
    pub fn is_readable(self) -> bool {
        matches!(
            self,
            ForgeKind::Github
                | ForgeKind::Gitlab
                | ForgeKind::Origin
                | ForgeKind::Gitea
                | ForgeKind::Forgejo
                | ForgeKind::Bitbucket
        )
    }
}

/// Public hosts whose provider is fixed (`publicForgeHosts`).
pub fn public_forge_host(host: &str) -> Option<ForgeKind> {
    match host {
        "github.com" => Some(ForgeKind::Github),
        "gitlab.com" => Some(ForgeKind::Gitlab),
        "bitbucket.org" => Some(ForgeKind::Bitbucket),
        "codeberg.org" => Some(ForgeKind::Forgejo),
        "origin.cursor.com" => Some(ForgeKind::Origin),
        _ => None,
    }
}

/// The provider a saved host entry names (`configuredForge`).
pub fn configured_forge(host: &str, explicit: Option<ForgeKind>) -> ForgeKind {
    explicit
        .or_else(|| public_forge_host(host))
        .unwrap_or(ForgeKind::Github)
}

/// A validated repository identity (`ForgeRepository`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ForgeRepository {
    pub forge: ForgeKind,
    pub host: String,
    pub owner: String,
    pub name: String,
}

impl ForgeRepository {
    /// Validates `forge`, `host`, `owner` and `name` against `ForgeRepository`'s Zod schema.
    pub fn validate(
        forge: ForgeKind,
        host: impl Into<String>,
        owner: impl Into<String>,
        name: impl Into<String>,
    ) -> Result<ForgeRepository, ForgeError> {
        static HOST_RE: std::sync::LazyLock<Regex> =
            std::sync::LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9.-]+$").expect("compiles"));
        static OWNER_RE: std::sync::LazyLock<Regex> =
            std::sync::LazyLock::new(|| Regex::new(r"^[\w.-]+(?:/[\w.-]+)*$").expect("compiles"));
        static NAME_RE: std::sync::LazyLock<Regex> =
            std::sync::LazyLock::new(|| Regex::new(r"^[\w.-]+$").expect("compiles"));
        let host = host.into();
        let owner = owner.into();
        let name = name.into();
        if host.chars().count() > 253
            || !HOST_RE.is_match(&host)
            || owner.chars().count() > 512
            || !OWNER_RE.is_match(&owner)
            || owner.split('/').any(|part| part == "." || part == "..")
            || name.chars().count() > 100
            || !NAME_RE.is_match(&name)
            || name == "."
            || name == ".."
        {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        Ok(ForgeRepository {
            forge,
            host,
            owner,
            name,
        })
    }

    /// Canonical repository key (`repositoryKey`).
    pub fn key(&self) -> String {
        crate::transport::key::repository_key(
            self.forge.as_str(),
            &self.host,
            &self.owner,
            &self.name,
        )
    }
}

/// A validated pull request or issue reference (`ForgePrRef` / `ForgeIssueRef`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ForgePrRef {
    pub repository: ForgeRepository,
    pub number: u64,
}

/// `op`'s native entry point.
pub fn probe(op: &str) -> Result<String, Error> {
    Err(Error::unimplemented(PART, op))
}
