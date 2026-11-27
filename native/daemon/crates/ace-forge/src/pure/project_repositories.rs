// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! Project repository resolution and saved-config normalization (`project-repositories.ts`, ADR 0120).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::pure::capabilities::forge_capabilities;
use crate::pure::remote::repository_from_remote;
use crate::pure::{ForgeKind, ForgeRepository, configured_forge, public_forge_host};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckoutRemote {
    pub name: String,
    pub fetch_urls: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPreference {
    pub host: String,
    pub forge: Option<ForgeKind>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceControlPreferences {
    pub remote: Option<String>,
    pub hosts: Vec<HostPreference>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRepositoryConfig {
    pub added: Vec<ForgeRepository>,
    pub hidden: Vec<ForgeRepository>,
    pub primary: Option<ForgeRepository>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectRepositorySource {
    Remote,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectRepositoryUnavailable {
    HostNotConfigured,
    ProviderMismatch,
    ProviderUnsupported,
    RemoteMissing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteRefusal {
    RepositoryHidden,
    RepositoryUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepository {
    pub repository: ForgeRepository,
    pub capabilities: Vec<String>,
    pub source: ProjectRepositorySource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    pub visible: bool,
    pub primary: bool,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<ProjectRepositoryUnavailable>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProjectRepositories {
    pub repositories: Vec<ProjectRepository>,
    pub primary: Option<ProjectRepository>,
}

fn configured_hosts_map(prefs: Option<&SourceControlPreferences>) -> HashMap<String, ForgeKind> {
    let Some(prefs) = prefs else {
        return HashMap::new();
    };
    prefs
        .hosts
        .iter()
        .map(|entry| {
            let host = entry.host.to_ascii_lowercase();
            let forge = configured_forge(&host, entry.forge);
            (host, forge)
        })
        .collect()
}

fn remote_repository(
    remote: &CheckoutRemote,
    hosts: &HashMap<String, ForgeKind>,
    aliases: &HashMap<String, String>,
) -> Option<ForgeRepository> {
    let url = remote.fetch_urls.first()?;
    repository_from_remote(url, hosts, aliases).ok()
}

fn manual_problem(
    repository: &ForgeRepository,
    preferences: Option<&SourceControlPreferences>,
) -> Option<ProjectRepositoryUnavailable> {
    let host = repository.host.to_ascii_lowercase();
    let entry = preferences.and_then(|prefs| {
        prefs
            .hosts
            .iter()
            .find(|candidate| candidate.host.eq_ignore_ascii_case(&host))
    });
    let forge = match entry {
        Some(e) => Some(configured_forge(&host, e.forge)),
        None => public_forge_host(&host),
    };
    let Some(forge) = forge else {
        return Some(ProjectRepositoryUnavailable::HostNotConfigured);
    };
    if forge == repository.forge {
        None
    } else {
        Some(ProjectRepositoryUnavailable::ProviderMismatch)
    }
}

/// Resolves a project's repositories (`resolveProjectRepositories`).
pub fn resolve_project_repositories(
    remotes: &[CheckoutRemote],
    preferences: Option<&SourceControlPreferences>,
    aliases: &HashMap<String, String>,
    config: Option<&ProjectRepositoryConfig>,
) -> ResolvedProjectRepositories {
    let hosts = configured_hosts_map(preferences);
    let preferred = preferences
        .and_then(|p| p.remote.as_deref())
        .unwrap_or("origin");
    let hidden: HashSet<String> = config
        .map(|c| c.hidden.iter().map(ForgeRepository::key).collect())
        .unwrap_or_default();

    let mut entries: Vec<(String, ProjectRepository)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut add = |repository: ForgeRepository,
                   source: ProjectRepositorySource,
                   remote: Option<String>,
                   problem: Option<ProjectRepositoryUnavailable>| {
        let key = repository.key();
        if seen.contains(&key) || entries.len() >= 128 {
            return;
        }
        let unavailable = problem.or_else(|| {
            if repository.forge.is_readable() {
                None
            } else {
                Some(ProjectRepositoryUnavailable::ProviderUnsupported)
            }
        });
        let entry = ProjectRepository {
            capabilities: forge_capabilities(repository.forge)
                .iter()
                .map(|c| (*c).to_owned())
                .collect(),
            repository,
            source,
            remote,
            visible: !hidden.contains(&key),
            primary: false,
            available: unavailable.is_none(),
            unavailable,
        };
        seen.insert(key.clone());
        entries.push((key, entry));
    };

    for remote in remotes.iter().filter(|r| r.name == preferred) {
        if let Some(repo) = remote_repository(remote, &hosts, aliases) {
            add(
                repo,
                ProjectRepositorySource::Remote,
                Some(remote.name.clone()),
                None,
            );
        }
    }
    for remote in remotes.iter().filter(|r| r.name != preferred) {
        if let Some(repo) = remote_repository(remote, &hosts, aliases) {
            add(
                repo,
                ProjectRepositorySource::Remote,
                Some(remote.name.clone()),
                None,
            );
        }
    }
    if let Some(cfg) = config {
        for repo in &cfg.added {
            add(
                repo.clone(),
                ProjectRepositorySource::Manual,
                None,
                manual_problem(repo, preferences),
            );
        }
        if let Some(primary) = &cfg.primary {
            add(
                primary.clone(),
                ProjectRepositorySource::Remote,
                None,
                Some(ProjectRepositoryUnavailable::RemoteMissing),
            );
        }
    }

    let find_idx = |entries: &[(String, ProjectRepository)], repo: &ForgeRepository| {
        let key = repo.key();
        entries.iter().position(|(k, _)| k == &key)
    };
    let legacy_remote = remotes.iter().find(|r| r.name == preferred).or_else(|| {
        if preferences.is_none() {
            remotes.first()
        } else {
            None
        }
    });
    let legacy_idx = legacy_remote
        .and_then(|r| remote_repository(r, &hosts, aliases))
        .and_then(|repo| find_idx(&entries, &repo));
    let config_primary_idx = config
        .and_then(|c| c.primary.as_ref())
        .and_then(|repo| find_idx(&entries, repo))
        .filter(|&i| entries[i].1.visible && entries[i].1.available);

    let chosen_idx = config_primary_idx
        .or_else(|| legacy_idx.filter(|&i| entries[i].1.visible))
        .or_else(|| {
            if config.is_some() {
                entries.iter().position(|(_, e)| e.visible && e.available)
            } else {
                None
            }
        });

    let primary = if let Some(idx) = chosen_idx {
        entries[idx].1.primary = true;
        Some(entries[idx].1.clone())
    } else {
        None
    };
    let repositories = entries.into_iter().map(|(_, e)| e).collect();
    ResolvedProjectRepositories {
        repositories,
        primary,
    }
}

/// Whether the project refuses a write to `repository` (`repositoryWriteRefusal`).
pub fn repository_write_refusal(
    resolved: &ResolvedProjectRepositories,
    repository: &ForgeRepository,
) -> Option<WriteRefusal> {
    let key = repository.key();
    let entry = resolved
        .repositories
        .iter()
        .find(|c| c.repository.key() == key)?;
    if !entry.visible {
        return Some(WriteRefusal::RepositoryHidden);
    }
    if !entry.available {
        return Some(WriteRefusal::RepositoryUnavailable);
    }
    None
}

fn unique_repos(repos: &[ForgeRepository]) -> Vec<ForgeRepository> {
    let mut seen = HashSet::new();
    repos
        .iter()
        .filter(|repo| seen.insert(repo.key()))
        .cloned()
        .collect()
}

/// Normalizes saved choices (`normalizeRepositoryConfig`), refusing a hidden primary.
pub fn normalize_repository_config(
    input: Option<&ProjectRepositoryConfig>,
) -> Result<Option<ProjectRepositoryConfig>, &'static str> {
    let Some(input) = input else {
        return Ok(None);
    };
    let hidden = unique_repos(&input.hidden);
    if let Some(primary) = &input.primary {
        let primary_key = primary.key();
        if hidden.iter().any(|r| r.key() == primary_key) {
            return Err("primary_hidden");
        }
    }
    let added = unique_repos(&input.added);
    if added.is_empty() && hidden.is_empty() && input.primary.is_none() {
        return Ok(None);
    }
    Ok(Some(ProjectRepositoryConfig {
        added,
        hidden,
        primary: input.primary.clone(),
    }))
}

fn config_shape(input: Option<&ProjectRepositoryConfig>) -> String {
    let normalized = match normalize_repository_config(input) {
        Ok(Some(cfg)) => cfg,
        Ok(None) => return String::new(),
        Err(_) => match input {
            Some(cfg) => cfg.clone(),
            None => return String::new(),
        },
    };
    let added: Vec<String> = normalized.added.iter().map(ForgeRepository::key).collect();
    let mut hidden: Vec<String> = normalized.hidden.iter().map(ForgeRepository::key).collect();
    hidden.sort();
    let primary = normalized.primary.as_ref().map(ForgeRepository::key);
    format!("{added:?}|{hidden:?}|{primary:?}")
}

/// Compares two saved repository configs by identity (`sameRepositoryConfig`).
pub fn same_repository_config(
    a: Option<&ProjectRepositoryConfig>,
    b: Option<&ProjectRepositoryConfig>,
) -> bool {
    config_shape(a) == config_shape(b)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{
        CheckoutRemote, ProjectRepositoryConfig, ProjectRepositoryUnavailable, WriteRefusal,
        normalize_repository_config, repository_write_refusal, resolve_project_repositories,
        same_repository_config,
    };
    use crate::pure::{ForgeKind, ForgeRepository};

    fn repo(owner: &str, name: &str) -> ForgeRepository {
        ForgeRepository::validate(ForgeKind::Github, "github.com", owner, name).expect("repo")
    }

    #[test]
    fn resolves_remotes_manual_entries_hidden_and_primary() {
        let remotes = vec![
            CheckoutRemote {
                name: String::from("upstream"),
                fetch_urls: vec![String::from("https://github.com/up/ace.git")],
            },
            CheckoutRemote {
                name: String::from("origin"),
                fetch_urls: vec![String::from("git@github.com:me/ace.git")],
            },
        ];
        let manual_unconfigured =
            ForgeRepository::validate(ForgeKind::Github, "ghe.unknown", "org", "app").expect("r");
        let cfg = ProjectRepositoryConfig {
            added: vec![manual_unconfigured.clone()],
            hidden: vec![repo("me", "ace")],
            primary: None,
        };
        let resolved = resolve_project_repositories(&remotes, None, &HashMap::new(), Some(&cfg));
        assert_eq!(resolved.repositories.len(), 3);
        assert_eq!(
            resolved
                .primary
                .as_ref()
                .map(|p| p.repository.owner.as_str()),
            Some("up")
        );
        assert_eq!(
            repository_write_refusal(&resolved, &repo("me", "ace")),
            Some(WriteRefusal::RepositoryHidden)
        );
        assert_eq!(
            repository_write_refusal(&resolved, &manual_unconfigured),
            Some(WriteRefusal::RepositoryUnavailable)
        );
        assert_eq!(
            resolved.repositories[2].unavailable,
            Some(ProjectRepositoryUnavailable::HostNotConfigured)
        );
    }

    #[test]
    fn normalize_refuses_hidden_primary_and_same_config_ignores_hidden_order() {
        let a = repo("octo", "a");
        let b = repo("octo", "b");
        assert_eq!(
            normalize_repository_config(Some(&ProjectRepositoryConfig {
                added: vec![],
                hidden: vec![a.clone()],
                primary: Some(a.clone()),
            })),
            Err("primary_hidden")
        );
        let c1 = ProjectRepositoryConfig {
            added: vec![],
            hidden: vec![a.clone(), b.clone()],
            primary: None,
        };
        let c2 = ProjectRepositoryConfig {
            added: vec![],
            hidden: vec![b, a],
            primary: None,
        };
        assert!(same_repository_config(Some(&c1), Some(&c2)));
    }
}
