// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! SSH host aliases (`ssh-aliases.ts`): `ssh -G` reads configuration only, never connects;
//! results are cached briefly so remote detection on hot paths spawns no process.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::transport::command::{Cancellation, CommandRequest, Runner};

/// Hosts that name themselves: no `ssh -G` lookup.
const LITERAL_HOSTS: [&str; 3] = ["github.com", "gitlab.com", "ssh.github.com"];

/// The host of an SSH remote (`user@host:path` or `ssh://user@host/path`), if it is one.
pub fn ssh_remote_host(remote: &str) -> Option<String> {
    if !remote.contains("://") {
        let (before, after) = remote.split_once(':')?;
        if after.starts_with('/') || before.contains('/') {
            return None;
        }
        let host = before.rsplit('@').next()?;
        return valid_host(host);
    }
    let rest = remote.strip_prefix("ssh://")?;
    let authority = rest.split('/').next()?;
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?;
    valid_host(host)
}

fn valid_host(host: &str) -> Option<String> {
    let host = host.to_lowercase();
    let valid = !host.is_empty()
        && host.len() <= 253
        && host.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
        && host
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric() || first == '_');
    valid.then_some(host)
}

/// The effective `hostname` from `ssh -G` output.
pub fn ssh_config_hostname(output: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim();
        let (key, value) = trimmed.split_once(char::is_whitespace)?;
        if key.eq_ignore_ascii_case("hostname") {
            let value = value.trim();
            if !value.is_empty()
                && value.len() <= 253
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
                })
            {
                return Some(value.to_lowercase());
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
struct Cached {
    host: Option<String>,
    at: f64,
}

/// Resolves SSH host aliases (multi-account `Host github-work` entries) to their host.
pub struct SshHostAliases<'a> {
    runner: &'a dyn Runner,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
    ttl_ms: f64,
    command: String,
    cache: Mutex<HashMap<String, Cached>>,
}

impl<'a> SshHostAliases<'a> {
    /// A resolver over `runner`, with a five-minute cache and the person's `ssh`.
    pub fn new(
        runner: &'a dyn Runner,
        now: Box<dyn Fn() -> f64 + Send + Sync>,
    ) -> SshHostAliases<'a> {
        SshHostAliases {
            runner,
            now,
            ttl_ms: 300_000.0,
            command: String::from("ssh"),
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Alias to real host, for each SSH remote host whose configuration names another host.
    pub async fn resolve(
        &self,
        remotes: &[String],
        cancellation: Option<std::sync::Arc<Cancellation>>,
    ) -> HashMap<String, String> {
        let mut result = HashMap::new();
        let mut hosts: Vec<String> = Vec::new();
        for remote in remotes {
            let Some(host) = ssh_remote_host(remote) else {
                continue;
            };
            if LITERAL_HOSTS.contains(&host.as_str()) || hosts.contains(&host) {
                continue;
            }
            hosts.push(host);
        }
        for host in hosts {
            if let Some(resolved) = self.lookup(&host, cancellation.clone()).await
                && resolved != host
            {
                result.insert(host, resolved);
            }
        }
        result
    }

    async fn lookup(
        &self,
        host: &str,
        cancellation: Option<std::sync::Arc<Cancellation>>,
    ) -> Option<String> {
        let now = (self.now)();
        if let Some(cached) = self.cache.lock().expect("alias cache lock").get(host)
            && now - cached.at >= 0.0
            && now - cached.at < self.ttl_ms
        {
            return cached.host.clone();
        }
        let request = CommandRequest::new(
            self.command.clone(),
            vec![String::from("-G"), host.to_owned()],
        );
        let request = match cancellation {
            Some(cancellation) => request.cancellable(cancellation),
            None => request,
        };
        let resolved = match self.runner.run(request).await {
            Ok(output) if output.code == Some(0) => ssh_config_hostname(&output.stdout),
            _ => None,
        };
        let mut cache = self.cache.lock().expect("alias cache lock");
        cache.insert(
            host.to_owned(),
            Cached {
                host: resolved.clone(),
                at: now,
            },
        );
        while cache.len() > 256
            && let Some(oldest) = cache.keys().next().cloned()
        {
            cache.remove(&oldest);
        }
        resolved
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use std::pin::Pin;
    use std::sync::Mutex;

    use super::{SshHostAliases, ssh_config_hostname, ssh_remote_host};
    use crate::transport::command::{CommandRequest, CommandResult, Runner};

    #[test]
    fn remotes_name_their_ssh_host() {
        assert_eq!(
            ssh_remote_host("git@github.com:octo/ace.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            ssh_remote_host("ssh://git@GitLab.example:2222/team/ace.git").as_deref(),
            Some("gitlab.example")
        );
        assert_eq!(
            ssh_remote_host("git@github-work:octo/ace.git").as_deref(),
            Some("github-work")
        );
        assert_eq!(ssh_remote_host("https://github.com/octo/ace.git"), None);
        assert_eq!(ssh_remote_host("/local/path:repo"), None);
        assert_eq!(ssh_remote_host("git@bad host:octo/ace.git"), None);
    }

    #[test]
    fn ssh_config_names_the_effective_hostname() {
        assert_eq!(
            ssh_config_hostname("user git\nhostname GitHub.com\nport 22\n").as_deref(),
            Some("github.com")
        );
        assert_eq!(ssh_config_hostname("user git\nhost github.com\n"), None);
    }

    #[derive(Default)]
    struct Stub {
        replies: Mutex<Vec<CommandResult>>,
        seen: Mutex<Vec<CommandRequest>>,
    }

    impl Runner for Stub {
        fn run<'a>(
            &'a self,
            request: CommandRequest,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<CommandResult, crate::transport::error::ForgeError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                self.seen.lock().expect("seen").push(request);
                Ok(self.replies.lock().expect("replies").remove(0))
            })
        }
    }

    fn output(text: &str) -> CommandResult {
        CommandResult {
            code: Some(0),
            stdout: text.to_owned(),
            truncated: false,
            identity_changed: false,
            http: None,
            unreachable: false,
        }
    }

    #[test]
    fn an_alias_resolves_through_ssh_and_is_cached() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let stub = Stub {
                replies: Mutex::new(vec![output("hostname github.com\n")]),
                seen: Mutex::new(Vec::new()),
            };
            let aliases = SshHostAliases::new(&stub, Box::new(|| 0.0));
            let remotes = vec![
                String::from("git@github-work:octo/ace.git"),
                String::from("git@github.com:octo/ace.git"),
            ];
            let resolved = aliases.resolve(&remotes, None).await;
            assert_eq!(
                resolved.get("github-work").map(String::as_str),
                Some("github.com")
            );
            assert_eq!(resolved.len(), 1);
            let first = aliases.resolve(&remotes, None).await;
            assert_eq!(first, resolved);
            assert_eq!(stub.seen.lock().expect("seen").len(), 1);
        });
    }
}
