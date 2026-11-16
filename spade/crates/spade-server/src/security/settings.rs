//! What the person set for one bot's security (ADR 0167 decision 10), stored as one setting,
//! `security:<bot id>`. Only the person's API writes it; no bot tool changes it.

use serde::{Deserialize, Serialize};
use spade_core::grant::Grant;
use spade_sandbox::egress::NetworkPolicy;

/// One bot's security settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotSecurity {
    /// What its commands, terminal and services reach.
    #[serde(default)]
    pub network: NetworkPolicy,
    /// What its plugins' hooks and servers reach; `None` is `open` (the person installed them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_network: Option<NetworkPolicy>,
    /// Toolchain folders the person confirmed: read-only in the sandbox, their `bin` on `PATH`.
    #[serde(default)]
    pub toolchains: Vec<String>,
    /// Its grants, consented folders among them.
    #[serde(default)]
    pub grants: Vec<Grant>,
}

impl BotSecurity {
    pub fn plugin_network(&self) -> NetworkPolicy {
        self.plugin_network
            .clone()
            .unwrap_or_else(NetworkPolicy::open)
    }
}

/// The setting a bot's security is stored under.
pub fn key(bot: &str) -> String {
    format!("security:{bot}")
}

/// A stored value read leniently: one that doesn't parse reads as the defaults, never as an
/// error that would stop the bot's commands.
pub fn read(stored: Option<&str>) -> BotSecurity {
    stored
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bot_with_nothing_stored_has_the_dev_allow_list_and_open_plugins() {
        let fresh = read(None);
        assert_eq!(fresh.network, NetworkPolicy::default());
        assert_eq!(fresh.plugin_network(), NetworkPolicy::open());
        assert!(fresh.grants.is_empty() && fresh.toolchains.is_empty());
        assert_eq!(read(Some("not json")), fresh);
    }
}
