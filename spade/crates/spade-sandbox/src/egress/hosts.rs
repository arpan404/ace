//! A bot's network policy (ADR 0167 decision 3): which hosts its sandboxed runs may reach through
//! the egress proxy. Pure.

use std::net::IpAddr;

use serde::{Deserialize, Serialize};

/// How a bot's runs reach the network.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// No connection at all.
    Off,
    /// The defaults (unless dropped) and the person's additions.
    #[default]
    AllowList,
    /// Any public host. Plugin servers' default: the person installed them.
    Open,
}

impl Mode {
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "off" => Some(Self::Off),
            "allow_list" => Some(Self::AllowList),
            "open" => Some(Self::Open),
            _ => None,
        }
    }
}

/// Package registries and git hosts: what dev work needs by default.
pub const DEFAULTS: &[&str] = &[
    // JavaScript
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "repo.yarnpkg.com",
    "registry.bun.sh",
    "jsr.io",
    // Python
    "pypi.org",
    "files.pythonhosted.org",
    // Rust
    "crates.io",
    "index.crates.io",
    "static.crates.io",
    "static.rust-lang.org",
    // Go
    "proxy.golang.org",
    "sum.golang.org",
    // Ruby, Java, PHP, .NET, Elixir, Dart, Swift
    "rubygems.org",
    "index.rubygems.org",
    "repo.maven.apache.org",
    "repo1.maven.org",
    "plugins.gradle.org",
    "packagist.org",
    "repo.packagist.org",
    "api.nuget.org",
    "repo.hex.pm",
    "pub.dev",
    "cdn.cocoapods.org",
    // Homebrew's bottles
    "formulae.brew.sh",
    "ghcr.io",
    "pkg-containers.githubusercontent.com",
    // Git hosts
    "github.com",
    "api.github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    "gitlab.com",
    "bitbucket.org",
    "codeberg.org",
    "git.sr.ht",
];

/// A bot's network policy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkPolicy {
    #[serde(default)]
    pub mode: Mode,
    /// The person's additions: `host`, `*.host` (its subdomains) or either with `:port`.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Defaults the person dropped.
    #[serde(default)]
    pub dropped: Vec<String>,
}

impl NetworkPolicy {
    pub fn off() -> Self {
        Self {
            mode: Mode::Off,
            ..Self::default()
        }
    }

    pub fn open() -> Self {
        Self {
            mode: Mode::Open,
            ..Self::default()
        }
    }

    /// Every entry in force: the defaults not dropped, then the additions.
    pub fn entries(&self) -> Vec<String> {
        DEFAULTS
            .iter()
            .filter(|d| !self.dropped.iter().any(|x| x == *d))
            .map(|d| (*d).to_owned())
            .chain(self.allow.iter().cloned())
            .collect()
    }

    /// Whether a run may connect to `host:port`, before its name is resolved.
    pub fn verdict(&self, host: &str, port: u16) -> Verdict {
        let host = normal(host);
        if host.is_empty() {
            return Verdict::Refused("no host was named".to_owned());
        }
        match self.mode {
            Mode::Off => Verdict::Refused("this bot's network is off".to_owned()),
            Mode::Open if !local_name(&host) => Verdict::Allowed { local: false },
            Mode::Open | Mode::AllowList => {
                let matched = self
                    .entries()
                    .iter()
                    .find_map(|entry| Entry::parse(entry).filter(|e| e.covers(&host, port)));
                match matched {
                    Some(entry) => Verdict::Allowed {
                        local: entry.local(),
                    },
                    None if local_name(&host) => Verdict::Refused(
                        "this machine and the local network are reached only when the person \
                         adds the host and port"
                            .to_owned(),
                    ),
                    None => {
                        Verdict::Refused(format!("{host} is not on this bot's network allow-list"))
                    }
                }
            }
        }
    }

    /// Checks an addition's form: refused with why, else the entry as kept.
    pub fn check_entry(entry: &str) -> Result<String, String> {
        let entry = entry.trim().to_ascii_lowercase();
        match Entry::parse(&entry) {
            Some(_) => Ok(entry),
            None => Err(format!(
                "{entry} is not a host, *.host or host:port (no scheme, path or other wildcard)"
            )),
        }
    }
}

/// What a request may do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Allowed; `local` when the entry named a local host literally, so it may resolve to a
    /// private address.
    Allowed {
        local: bool,
    },
    Refused(String),
}

/// Whether a resolved address is outside the public internet (loopback, private, link-local,
/// unique-local, unspecified, multicast or reserved).
pub fn private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.octets()[0] == 0
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
                || v4.octets()[0] >= 240
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return private(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
    }
}

fn normal(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

/// A name that is this machine or the local network on its face.
fn local_name(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.parse::<IpAddr>().is_ok_and(private)
}

/// One allow-list entry.
struct Entry {
    host: String,
    /// `*.host`: its subdomains, not itself.
    subdomains: bool,
    port: Option<u16>,
}

impl Entry {
    fn parse(entry: &str) -> Option<Self> {
        let entry = entry.trim().to_ascii_lowercase();
        let (host, port) = match entry.rsplit_once(':') {
            // An IPv6 literal is written in brackets with its port.
            Some((host, port)) if !host.contains(':') || host.ends_with(']') => {
                (host.to_owned(), Some(port.parse::<u16>().ok()?))
            }
            _ => (entry.clone(), None),
        };
        let host = normal(&host);
        let (subdomains, host) = match host.strip_prefix("*.") {
            Some(rest) => (true, rest.to_owned()),
            None => (false, host),
        };
        let fine = !host.is_empty()
            && (host.parse::<IpAddr>().is_ok()
                || host
                    .split('.')
                    .all(|label| !label.is_empty() && label.chars().all(label_char)));
        fine.then_some(Self {
            host,
            subdomains,
            port,
        })
    }

    fn covers(&self, host: &str, port: u16) -> bool {
        let named = if self.subdomains {
            host.strip_suffix(&self.host)
                .is_some_and(|rest| rest.ends_with('.') && rest.len() > 1)
        } else {
            host == self.host
        };
        named
            && match self.port {
                Some(only) => only == port,
                // Without a port: the web's.
                None => port == 443 || port == 80,
            }
    }

    fn local(&self) -> bool {
        !self.subdomains && local_name(&self.host)
    }
}

fn label_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(policy: &NetworkPolicy, host: &str, port: u16) -> bool {
        matches!(policy.verdict(host, port), Verdict::Allowed { .. })
    }

    #[test]
    fn the_default_allow_list_reaches_registries_and_git_hosts_on_web_ports_only() {
        let policy = NetworkPolicy::default();
        assert!(allowed(&policy, "registry.npmjs.org", 443));
        assert!(allowed(&policy, "GitHub.com.", 443));
        assert!(allowed(&policy, "crates.io", 80));
        assert!(!allowed(&policy, "github.com", 22));
        assert!(!allowed(&policy, "evil.example", 443));
        assert!(!allowed(&policy, "github.com.evil.example", 443));
    }

    #[test]
    fn the_person_adds_hosts_subdomains_and_ports_and_drops_defaults() {
        let policy = NetworkPolicy {
            mode: Mode::AllowList,
            allow: vec![
                "docs.rs".into(),
                "*.example.com".into(),
                "api.local.test:8443".into(),
            ],
            dropped: vec!["github.com".into()],
        };
        assert!(allowed(&policy, "docs.rs", 443));
        assert!(allowed(&policy, "a.b.example.com", 443));
        assert!(!allowed(&policy, "example.com", 443));
        assert!(allowed(&policy, "api.local.test", 8443));
        assert!(!allowed(&policy, "api.local.test", 443));
        assert!(!allowed(&policy, "github.com", 443));
        assert!(allowed(&policy, "api.github.com", 443));
    }

    #[test]
    fn this_machine_is_reached_only_through_an_entry_naming_it() {
        let open = NetworkPolicy::open();
        for host in [
            "localhost",
            "127.0.0.1",
            "10.0.0.5",
            "[::1]",
            "printer.local",
        ] {
            assert!(!allowed(&open, host, 80), "{host}");
        }
        assert!(allowed(&open, "example.org", 8080));
        let policy = NetworkPolicy {
            allow: vec!["localhost:3000".into()],
            ..NetworkPolicy::default()
        };
        assert_eq!(
            policy.verdict("localhost", 3000),
            Verdict::Allowed { local: true }
        );
        assert!(!allowed(&policy, "localhost", 3001));
        assert_eq!(
            policy.verdict("github.com", 443),
            Verdict::Allowed { local: false }
        );
    }

    #[test]
    fn a_bot_with_its_network_off_reaches_nothing() {
        let off = NetworkPolicy::off();
        assert!(!allowed(&off, "registry.npmjs.org", 443));
    }

    #[test]
    fn addresses_outside_the_public_internet_are_private() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            let parsed: IpAddr = address.parse().unwrap_or_else(|_| std::process::abort());
            assert!(private(parsed), "{address}");
        }
        for address in ["140.82.112.3", "2606:4700::1111"] {
            let parsed: IpAddr = address.parse().unwrap_or_else(|_| std::process::abort());
            assert!(!private(parsed), "{address}");
        }
    }

    #[test]
    fn an_entry_is_a_host_a_subdomain_pattern_or_either_with_a_port() {
        for good in [
            "docs.rs",
            "*.example.com",
            "localhost:3000",
            "10.0.0.2:5432",
        ] {
            assert!(NetworkPolicy::check_entry(good).is_ok(), "{good}");
        }
        for bad in [
            "https://docs.rs",
            "docs.rs/path",
            "*",
            "a*.b.com",
            "x:port",
            "",
        ] {
            assert!(NetworkPolicy::check_entry(bad).is_err(), "{bad}");
        }
    }
}
