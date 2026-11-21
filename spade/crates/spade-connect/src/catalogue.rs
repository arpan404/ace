//! The shipped list of well-known remote MCP servers (`spade/config/connectors.json`), each
//! checked against its maker's own documentation and live sign-in metadata on its `checked` date.
//! Their icons live with the apps that draw them (`packages/ui-core/src/spade-chat/app-icons`).

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    /// Spade Cloud, which holds the app's client secret (ADR 0140).
    Cloud,
}

/// Where an app sits in the list people pick from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    MailChat,
    Meetings,
    #[default]
    Work,
    Files,
    SalesSupport,
    Code,
    Data,
    Money,
    Design,
}

/// What an entry waits for before Spade can sign in to it, besides anything the person does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitsFor {
    /// The maker lets in only apps it approved (a catalog, a redirect allow list); Spade isn't
    /// yet. The owner asks the maker, then removes this from the entry.
    MakerApproval,
}

/// Whether a person can connect an entry on this build, today.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Ready {
    /// Sign in with one click.
    SignIn,
    /// Only with a token or key the person makes in the app.
    Key,
    /// Not yet: it waits for the owner (a registration, the maker's approval). Someone who
    /// registers their own app with the maker can still use its client ID.
    Later,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub category: Category,
    /// Words a task that needs it may use ("issues", "inbox"): how [`crate::fit`] finds the
    /// apps that fit a bot's task or a need it names, with no model call.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<String>,
    pub url: String,
    pub sign_in: Vec<SignIn>,
    #[serde(default)]
    pub notes: String,
    /// The maker's page the address was checked against.
    pub source: String,
    /// The day it was last checked against `source` and the server's live metadata.
    #[serde(default)]
    pub checked: String,
    /// The maker's page where the person makes a token, for entries that take one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waits_for: Option<WaitsFor>,
    /// Signs in through Spade Cloud rather than as Spade's own client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<Via>,
    /// Its sign-in may use local addresses. Never read from the shipped file, so catalogue
    /// servers never are; tests set it to point an entry at a fake app on 127.0.0.1.
    #[serde(skip)]
    pub local: bool,
    /// What its tools do at least (ADR 0171), by the server's own tool name: an effect word
    /// (`send_as_person`, `pay`, `publish`…) or a list of them. The tool's annotations can
    /// raise it, never lower it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub effects: BTreeMap<String, Value>,
    /// What every tool of the app does at least (`pay` for a payments app), read-only or not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_tool: Option<Value>,
    /// ace reviewed this server and trusts its tools' annotations (ADR 0202 §2): a tool it marks
    /// `readOnlyHint: true` reads without asking, any other annotated tool reaches outside the
    /// bot. Without it the annotations are the server's own word and lower nothing. Only a
    /// shipped entry carries it; a server added by URL never does.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trusted_annotations: bool,
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

/// An entry as the app is shown it: the entry, and whether it can be connected now.
#[derive(Debug, Clone, Serialize)]
pub struct Listed<'a> {
    #[serde(flatten)]
    pub entry: &'a Entry,
    pub ready: Ready,
}

/// Whether `entry` can be connected now. `cloud_apps` are the apps Spade Cloud says it can sign
/// in to (it has their client), `None` without the cloud or before it answered: an entry that
/// signs in through the cloud is then `Later`, never a Sign in that would fail.
pub fn ready(entry: &Entry, cloud_apps: Option<&HashSet<String>>) -> Ready {
    let through_cloud =
        entry.via == Some(Via::Cloud) && !cloud_apps.is_some_and(|apps| apps.contains(&entry.id));
    let one_click =
        entry.sign_in.contains(&SignIn::Oauth) && entry.waits_for.is_none() && !through_cloud;
    if one_click {
        Ready::SignIn
    } else if entry.sign_in.contains(&SignIn::Token) {
        Ready::Key
    } else {
        Ready::Later
    }
}

/// The catalogue as the app is shown it.
pub fn listed<'a>(entries: &'a [Entry], cloud_apps: Option<&HashSet<String>>) -> Vec<Listed<'a>> {
    entries
        .iter()
        .map(|entry| Listed {
            entry,
            ready: ready(entry, cloud_apps),
        })
        .collect()
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
            assert!(
                is_day(&entry.checked),
                "{}: checked {:?}",
                entry.id,
                entry.checked
            );
            if let Some(key) = &entry.key_url {
                assert!(key.starts_with("https://"), "{}", entry.id);
                assert!(entry.sign_in.contains(&SignIn::Token), "{}", entry.id);
            }
            // A person with only a token to offer is shown where to make one.
            if entry.sign_in == [SignIn::Token] {
                assert!(entry.key_url.is_some(), "{} takes only a token", entry.id);
            }
        }
    }

    fn is_day(text: &str) -> bool {
        let parts: Vec<&str> = text.split('-').collect();
        parts.len() == 3
            && [4, 2, 2]
                .iter()
                .zip(&parts)
                .all(|(len, part)| part.len() == *len && part.chars().all(|c| c.is_ascii_digit()))
    }

    #[test]
    fn the_shipped_file_names_every_field_it_holds() {
        // An unknown field would be dropped by serde, so a typo would ship silently.
        let raw: Value = serde_json::from_str(SHIPPED).unwrap_or_default();
        let known = [
            "id",
            "name",
            "category",
            "words",
            "url",
            "sign_in",
            "via",
            "waits_for",
            "notes",
            "key_url",
            "source",
            "checked",
            "effects",
            "every_tool",
        ];
        for entry in raw["connectors"].as_array().into_iter().flatten() {
            for key in entry.as_object().into_iter().flatten().map(|(key, _)| key) {
                assert!(known.contains(&key.as_str()), "{}: {key}", entry["id"]);
            }
        }
    }

    #[test]
    fn an_entry_is_ready_to_sign_in_only_when_nothing_waits_for_the_owner() {
        let entry = |sign_in: Vec<SignIn>, via: Option<Via>, waits_for: Option<WaitsFor>| Entry {
            id: "app".into(),
            sign_in,
            via,
            waits_for,
            ..Entry::default()
        };
        let cloud: HashSet<String> = ["app".to_owned()].into();
        let none = HashSet::new();
        let table = [
            (entry(vec![SignIn::Oauth], None, None), None, Ready::SignIn),
            (
                entry(vec![SignIn::Oauth, SignIn::Token], None, None),
                None,
                Ready::SignIn,
            ),
            (
                entry(vec![SignIn::Token, SignIn::OauthClient], None, None),
                None,
                Ready::Key,
            ),
            (
                entry(vec![SignIn::OauthClient], None, None),
                None,
                Ready::Later,
            ),
            // The maker hasn't approved Spade yet: a Sign in would fail.
            (
                entry(vec![SignIn::Oauth], None, Some(WaitsFor::MakerApproval)),
                None,
                Ready::Later,
            ),
            (
                entry(
                    vec![SignIn::Oauth, SignIn::Token],
                    None,
                    Some(WaitsFor::MakerApproval),
                ),
                None,
                Ready::Key,
            ),
            // Through the cloud: only once the cloud says it holds the app's client.
            (
                entry(
                    vec![SignIn::Oauth, SignIn::OauthClient],
                    Some(Via::Cloud),
                    None,
                ),
                Some(&cloud),
                Ready::SignIn,
            ),
            (
                entry(
                    vec![SignIn::Oauth, SignIn::OauthClient],
                    Some(Via::Cloud),
                    None,
                ),
                Some(&none),
                Ready::Later,
            ),
            (
                entry(
                    vec![SignIn::Oauth, SignIn::OauthClient],
                    Some(Via::Cloud),
                    None,
                ),
                None,
                Ready::Later,
            ),
        ];
        for (entry, apps, want) in table {
            assert_eq!(
                ready(&entry, apps),
                want,
                "{:?} {:?} {apps:?}",
                entry.sign_in,
                entry.waits_for
            );
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
