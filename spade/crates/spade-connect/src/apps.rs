//! Spade's own registered apps (`spade/config/connector-apps.json`, ADR 0137): a public client ID
//! the owner registered with an app's maker, shipped so the person signs in with one click. Public
//! means no secret: the file can't carry one, and a sign-in with a shipped ID never sends one.
//!
//! An app is tied to its catalogue entry and its authorization server's issuer: it is used only
//! when the person connects that entry, at the entry's own address, and that server's metadata
//! names the issuer. A server added by URL never gets it, even one naming the same issuer, so a
//! token issued to Spade's app only ever goes to the maker's own MCP server.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How Spade signs in with a shipped app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Grant {
    /// The device authorization grant (RFC 8628): the person enters a code on the app's page.
    Device,
    /// The authorization code grant with PKCE, back to the connector's own loopback callback
    /// (`http://127.0.0.1:<any port>/v1/connectors/callback/<connector>`).
    Browser,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct App {
    /// The catalogue entry it signs in to; its callback path for [`Grant::Browser`].
    pub connector: String,
    /// The authorization server the client ID was registered with.
    pub issuer: String,
    /// Empty until the owner registers the app.
    pub client_id: String,
    pub grant: Grant,
    /// The scopes to ask for. Absent: the MCP server's own, as for any connector.
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    /// The maker's page that says this grant works without a secret.
    pub source: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[allow(dead_code)]
    checked: String,
    #[allow(dead_code)]
    #[serde(default)]
    about: String,
    apps: Vec<App>,
}

const SHIPPED: &str = include_str!("../../../config/connector-apps.json");

/// Reads an apps file. Refused whole if anything in it is, or is named like, a secret: a shipped
/// app is public, so a secret in the file would be published with every copy of Spade.
pub fn parse(text: &str) -> Result<Vec<App>, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if let Some(key) = secret_key(&value) {
        return Err(format!(
            "a shipped app never carries a client secret, so `{key}` is refused"
        ));
    }
    let file: File = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    for app in &file.apps {
        if !seen.insert(app.connector.as_str()) {
            return Err(format!("{} has two apps", app.connector));
        }
        if !app.issuer.starts_with("https://") || !app.source.starts_with("https://") {
            return Err(format!(
                "{}: the issuer and source must be https",
                app.connector
            ));
        }
        if app.client_id.trim() != app.client_id {
            return Err(format!(
                "{}: the client ID has spaces around it",
                app.connector
            ));
        }
    }
    Ok(file.apps)
}

fn secret_key(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => map.iter().find_map(|(key, inner)| {
            if key.to_ascii_lowercase().contains("secret") {
                Some(key.clone())
            } else {
                secret_key(inner)
            }
        }),
        Value::Array(items) => items.iter().find_map(secret_key),
        _ => None,
    }
}

/// The shipped apps the owner has registered (those with a client ID).
pub fn shipped() -> Vec<App> {
    // Part of this build and checked by the test below, so it always reads.
    parse(SHIPPED)
        .unwrap_or_default()
        .into_iter()
        .filter(|app| !app.client_id.is_empty())
        .collect()
}

/// Spade's app for catalogue entry `connector` signing in at `issuer`, if it ships one.
pub(crate) fn for_sign_in<'a>(apps: &'a [App], connector: &str, issuer: &str) -> Option<&'a App> {
    apps.iter().find(|app| {
        app.connector == connector
            && app.issuer.trim_end_matches('/') == issuer.trim_end_matches('/')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_file_reads_and_names_catalogue_entries() {
        let apps = parse(SHIPPED).unwrap_or_else(|e| panic!("{e}"));
        assert!(!apps.is_empty());
        let catalogue = crate::catalogue::shipped();
        for app in &apps {
            assert!(
                catalogue.iter().any(|entry| entry.id == app.connector),
                "{} is not in the catalogue",
                app.connector
            );
        }
    }

    #[test]
    fn a_file_carrying_a_client_secret_anywhere_is_refused() {
        let with = |extra: &str| {
            format!(
                r#"{{"checked":"2026-11-12","apps":[{{"connector":"github","issuer":"https://github.com/login/oauth","client_id":"Iv1.abc","grant":"device","source":"https://docs.github.com"{extra}}}]}}"#
            )
        };
        assert!(parse(&with("")).is_ok());
        for extra in [
            r#","client_secret":"shh""#,
            r#","clientSecret":"shh""#,
            r#","scopes":["repo"],"extra":{"CLIENT_SECRET":"shh"}"#,
        ] {
            let refused = parse(&with(extra)).err().unwrap_or_default();
            assert!(
                refused.contains("never carries a client secret"),
                "{extra}: {refused}"
            );
        }
        // Not named a secret, but not something an app has either.
        assert!(parse(&with(r#","password":"shh""#)).is_err());
    }
}
