//! The shipped list of well-known remote MCP servers (`spade/config/connectors.json`), each
//! checked against its maker's own documentation on the date the file records.

use serde::{Deserialize, Serialize};

/// How a server can be signed in to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignIn {
    /// OAuth with automatic client registration: one click.
    Oauth,
    /// OAuth with a client ID (and maybe secret) the person registers with the app's maker.
    OauthClient,
    /// A token or API key the person creates in the app.
    Token,
}

/// Who signs in for an entry other than Spade itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    /// Spade Cloud, which holds the app's client secret (ADR 0139).
    Cloud,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub url: String,
    pub sign_in: Vec<SignIn>,
    #[serde(default)]
    pub notes: String,
    /// The maker's page the address was checked against.
    pub source: String,
    /// Signs in through Spade Cloud rather than as Spade's own client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<Via>,
    /// Its sign-in may use local addresses. Never read from the shipped file, so catalogue
    /// servers never are; tests set it to point an entry at a fake app on 127.0.0.1.
    #[serde(skip)]
    pub local: bool,
}

#[derive(Deserialize)]
struct File {
    connectors: Vec<Entry>,
}

const SHIPPED: &str = include_str!("../../../config/connectors.json");

/// The shipped catalogue, by name.
pub fn shipped() -> Vec<Entry> {
    // The file is part of this build and checked by the test below, so it always reads.
    let mut entries = serde_json::from_str::<File>(SHIPPED)
        .map(|file| file.connectors)
        .unwrap_or_default();
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    entries
}

/// The catalogue with Spade's registered apps applied: an entry Spade ships a client ID for signs
/// in with one click, so `oauth` leads its ways in. The person's own client ID stays offered.
pub fn with_apps(mut entries: Vec<Entry>, apps: &[crate::apps::App]) -> Vec<Entry> {
    for entry in &mut entries {
        let shipped = apps
            .iter()
            .any(|app| app.connector == entry.id && !app.client_id.is_empty());
        if shipped && !entry.sign_in.contains(&SignIn::Oauth) {
            entry.sign_in.insert(0, SignIn::Oauth);
        }
    }
    entries
}

/// The catalogue with Spade Cloud applied: an entry marked `via: "cloud"` signs in with one click
/// when the cloud is on, so `oauth` leads its ways in. The person's own client ID stays offered.
pub fn with_cloud(mut entries: Vec<Entry>, cloud: bool) -> Vec<Entry> {
    for entry in &mut entries {
        if cloud && entry.via == Some(Via::Cloud) && !entry.sign_in.contains(&SignIn::Oauth) {
            entry.sign_in.insert(0, SignIn::Oauth);
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shipped_entry_is_an_https_server_with_a_source_and_a_way_in() {
        let entries = shipped();
        assert!(entries.len() >= 15, "the shipped file did not read");
        let mut ids = std::collections::HashSet::new();
        for entry in &entries {
            assert!(ids.insert(entry.id.clone()), "{} twice", entry.id);
            assert!(
                entry
                    .id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{}",
                entry.id
            );
            assert!(entry.url.starts_with("https://"), "{}", entry.url);
            assert!(entry.source.starts_with("https://"), "{}", entry.id);
            assert!(!entry.sign_in.is_empty(), "{}", entry.id);
        }
    }

    #[test]
    fn an_entry_signs_in_with_one_click_once_spade_ships_its_client_id() -> Result<(), String> {
        let apps = crate::apps::parse(
            r#"{"checked":"2026-11-12","apps":[
              {"connector":"github","issuer":"https://github.com/login/oauth","client_id":"Ov23li","grant":"device","source":"https://docs.github.com"},
              {"connector":"asana","issuer":"https://app.asana.com","client_id":"","grant":"browser","source":"https://developers.asana.com"}]}"#,
        )?;
        let entries = with_apps(shipped(), &apps);
        let ways = |id: &str| {
            entries
                .iter()
                .find(|e| e.id == id)
                .map(|e| e.sign_in.clone())
                .unwrap_or_default()
        };
        assert_eq!(
            ways("github"),
            [SignIn::Oauth, SignIn::Token, SignIn::OauthClient]
        );
        assert_eq!(ways("asana"), [SignIn::OauthClient], "no client ID yet");
        assert_eq!(ways("linear"), [SignIn::Oauth, SignIn::Token]);
        Ok(())
    }

    #[test]
    fn the_four_apps_that_need_a_secret_sign_in_through_spade_cloud_when_it_is_on() {
        let ways = |entries: &[Entry], id: &str| {
            entries
                .iter()
                .find(|e| e.id == id)
                .map(|e| e.sign_in.clone())
                .unwrap_or_default()
        };
        let on = with_cloud(shipped(), true);
        for id in ["asana", "box", "canva", "hubspot"] {
            assert_eq!(ways(&on, id), [SignIn::Oauth, SignIn::OauthClient], "{id}");
        }
        assert_eq!(
            ways(&on, "huggingface"),
            [SignIn::Token],
            "only entries marked via cloud"
        );
        let off = with_cloud(shipped(), false);
        assert_eq!(ways(&off, "asana"), [SignIn::OauthClient]);
    }
}
