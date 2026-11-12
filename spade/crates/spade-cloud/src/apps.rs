//! The apps Spade Cloud signs in to (`apps.json`): each one's issuer, endpoints, scopes, MCP
//! resource, and the names of the environment variables holding its client ID and secret. The
//! file never holds a client ID or secret itself.

use serde::Deserialize;

/// How the cloud authenticates to an app's token endpoint (RFC 6749 section 2.3.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientAuth {
    ClientSecretBasic,
    ClientSecretPost,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct App {
    /// Spade's catalogue id for it, and the `{app}` in the API's paths.
    pub id: String,
    pub name: String,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub client_auth: ClientAuth,
    #[serde(default)]
    pub scopes: Vec<String>,
    /// The MCP server the tokens are for (RFC 8707 `resource`).
    pub resource: String,
    pub client_id_env: String,
    pub client_secret_env: String,
}

impl App {
    /// The RFC 9207 check: `iss` names this app's issuer, a trailing slash aside.
    pub fn is_issuer(&self, iss: &str) -> bool {
        iss.trim_end_matches('/') == self.issuer.trim_end_matches('/')
    }
}

/// The client the cloud signs in to an app as. Its secret never appears in debug output.
#[derive(Clone)]
pub struct Client {
    pub id: String,
    pub secret: String,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// An app with its client, when the environment sets both of its variables.
#[derive(Debug, Clone)]
pub struct Configured {
    pub app: App,
    pub client: Option<Client>,
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

/// The apps shipped with this build.
pub const SHIPPED: &str = include_str!("../apps.json");

/// Reads an apps file. Every address must be https, ids unique, and the variable names plain.
pub fn parse(text: &str) -> Result<Vec<App>, String> {
    let file: File = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    for app in &file.apps {
        if !seen.insert(app.id.as_str()) {
            return Err(format!("{} is listed twice", app.id));
        }
        if !app
            .id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(format!(
                "{}: ids are lower-case letters, digits and dashes",
                app.id
            ));
        }
        for address in [
            &app.issuer,
            &app.authorization_endpoint,
            &app.token_endpoint,
            &app.resource,
        ] {
            if !address.starts_with("https://") || url::Url::parse(address).is_err() {
                return Err(format!("{}: {address} is not an https address", app.id));
            }
        }
        for name in [&app.client_id_env, &app.client_secret_env] {
            if name.is_empty()
                || !name
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            {
                return Err(format!("{}: {name} is not a variable name", app.id));
            }
        }
    }
    Ok(file.apps)
}

/// Each app with its client from `env`. An app missing either variable is listed but can't sign
/// anyone in.
pub fn configure(apps: Vec<App>, env: &dyn Fn(&str) -> Option<String>) -> Vec<Configured> {
    apps.into_iter()
        .map(|app| {
            let value = |name: &str| {
                env(name)
                    .map(|v| v.trim().to_owned())
                    .filter(|v| !v.is_empty())
            };
            let client = match (value(&app.client_id_env), value(&app.client_secret_env)) {
                (Some(id), Some(secret)) => Some(Client { id, secret }),
                _ => None,
            };
            Configured { app, client }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_apps_read_and_are_the_four_that_need_a_secret() {
        let apps = parse(SHIPPED).unwrap_or_else(|e| panic!("{e}"));
        let ids: Vec<&str> = apps.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["asana", "box", "canva", "hubspot"]);
    }

    #[test]
    fn an_app_is_usable_only_when_both_of_its_variables_are_set() {
        let apps = parse(SHIPPED).unwrap_or_else(|e| panic!("{e}"));
        let env = |name: &str| match name {
            "SPADE_CLOUD_ASANA_CLIENT_ID" => Some("asana-id".to_owned()),
            "SPADE_CLOUD_ASANA_CLIENT_SECRET" => Some("asana-secret".to_owned()),
            "SPADE_CLOUD_BOX_CLIENT_ID" => Some("box-id".to_owned()),
            _ => None,
        };
        let configured = configure(apps, &env);
        let usable: Vec<&str> = configured
            .iter()
            .filter(|c| c.client.is_some())
            .map(|c| c.app.id.as_str())
            .collect();
        assert_eq!(usable, ["asana"]);
        let debug = format!("{:?}", configured[0].client);
        assert!(!debug.contains("asana-secret"), "{debug}");
    }

    #[test]
    fn a_file_with_a_plain_http_endpoint_or_a_bad_variable_name_is_refused() {
        let file = |token: &str, var: &str| {
            format!(
                r#"{{"checked":"x","apps":[{{"id":"a","name":"A","issuer":"https://a","authorization_endpoint":"https://a/auth","token_endpoint":"{token}","client_auth":"client_secret_post","resource":"https://a/mcp","client_id_env":"{var}","client_secret_env":"S"}}]}}"#
            )
        };
        assert!(parse(&file("https://a/token", "ID")).is_ok());
        assert!(parse(&file("http://a/token", "ID")).is_err());
        assert!(parse(&file("https://a/token", "id; rm")).is_err());
    }
}
