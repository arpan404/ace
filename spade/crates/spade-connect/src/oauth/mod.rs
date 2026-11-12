//! OAuth 2.1 for remote MCP servers, as the MCP authorization spec (2026-07-28) asks of clients:
//! protected-resource metadata, authorization-server metadata (OAuth, then OpenID Connect),
//! client ID metadata documents ([`cimd`]), dynamic client registration, PKCE with S256, `state`, the `resource` indicator, the RFC 9207
//! issuer check, code exchange and refresh. Errors never quote a token.

pub mod challenge;
pub mod cimd;
pub mod net;
pub mod pkce;
pub mod wellknown;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use url::Url;

pub use challenge::Challenge;
pub use net::{Addresses, Net};

/// The longest a metadata document, registration or token answer may be.
const MOST_BYTES: usize = 256 * 1024;

/// Why a sign-in step failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OauthError {
    /// The server can't be signed in to this way (no metadata, no PKCE, bad addresses).
    #[error("{0}")]
    Unsupported(String),
    /// Signing in needs a client ID registered with the app's maker: the server offers no
    /// automatic registration.
    #[error("this app needs a client ID you register with its maker")]
    NeedsClient,
    /// The authorization server refused the grant: the sign-in expired or was revoked.
    #[error("the sign-in was refused: {0}")]
    Refused(String),
    /// Could not reach a server, or it answered something unreadable.
    #[error("{0}")]
    Network(String),
}

/// What the MCP server says about how to sign in to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resource {
    /// The `resource` value for authorization and token requests.
    pub resource: String,
    pub authorization_server: String,
    pub scopes: Vec<String>,
}

/// An authorization server's metadata, as far as Spade uses it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthServer {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub code_challenge_methods_supported: Option<Vec<String>>,
    #[serde(default)]
    pub scopes_supported: Option<Vec<String>>,
    #[serde(default)]
    pub token_endpoint_auth_methods_supported: Option<Vec<String>>,
    #[serde(default)]
    pub authorization_response_iss_parameter_supported: Option<bool>,
    /// The server fetches a client's metadata from an `https` client ID ([`cimd`]).
    #[serde(default)]
    pub client_id_metadata_document_supported: Option<bool>,
}

/// A client Spade signs in as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Client {
    pub id: String,
    /// Kept in the keychain by the caller; never stored with the record.
    pub secret: Option<String>,
    /// How the secret is sent: `client_secret_basic` or `client_secret_post`.
    pub auth_method: String,
    /// The redirect address the client was registered with, when Spade registered it.
    pub registered_redirect: Option<String>,
    /// The client ID is Spade's metadata document ([`cimd`]): the same for every server, so
    /// every answer must name its issuer.
    pub metadata_document: bool,
}

/// Tokens from a token endpoint. The caller puts them in the keychain at once.
#[derive(Clone, PartialEq, Eq)]
pub struct Tokens {
    pub access: String,
    pub refresh: Option<String>,
    /// Seconds from now, when the server said.
    pub expires_in: Option<u64>,
    pub scope: Option<String>,
    /// The person's account, when an ID token named it. Shown only, never trusted.
    pub account: Option<String>,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens")
            .field("expires_in", &self.expires_in)
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

/// Asks the MCP server, without a credential, whether it needs one. `Ok(None)`: it answered, so
/// no sign-in is needed. `Ok(Some(challenge))`: it refused with this challenge (possibly empty).
pub async fn probe(net: &Net, server: &Url) -> Result<Option<Challenge>, OauthError> {
    let (http, server) = net.client(server.as_str()).await?;
    let initialize = json!({
        "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": { "name": "spade", "version": env!("CARGO_PKG_VERSION") }
        }
    });
    let response = http
        .post(server)
        .header("accept", "application/json, text/event-stream")
        .json(&initialize)
        .send()
        .await
        .map_err(|error| {
            OauthError::Network(format!("could not reach the server: {}", short(&error)))
        })?;
    let status = response.status();
    if status.is_success() {
        return Ok(None);
    }
    let challenge = response
        .headers()
        .get_all("www-authenticate")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(challenge::parse);
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Ok(Some(challenge.unwrap_or_default())),
        // Some servers refuse a bare initialize in other ways; metadata still decides.
        _ => Ok(Some(challenge.unwrap_or_default())),
    }
}

/// Reads the server's protected-resource metadata: from the challenge's address, else the
/// well-known paths in order. The metadata must be about this server.
pub async fn discover_resource(
    net: &Net,
    server: &Url,
    challenge: &Challenge,
) -> Result<Resource, OauthError> {
    let candidates = match &challenge.resource_metadata {
        Some(address) => vec![address.clone()],
        None => wellknown::resource_metadata(server),
    };
    let mut document = None;
    for candidate in candidates {
        if let Some(found) = get_json(net, &candidate).await? {
            document = Some(found);
            break;
        }
    }
    let Some(document) = document else {
        return Err(OauthError::Unsupported(
            "the server does not say how to sign in to it".into(),
        ));
    };
    let resource = document
        .get("resource")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| wellknown::canonical_resource(server));
    let resource_url = wellknown::checked(&resource).map_err(OauthError::Unsupported)?;
    if !wellknown::same_origin(&resource_url, server) {
        return Err(OauthError::Unsupported(
            "the server's sign-in metadata is about a different server".into(),
        ));
    }
    let authorization_server = document
        .get("authorization_servers")
        .and_then(Value::as_array)
        .and_then(|servers| servers.iter().find_map(Value::as_str))
        .ok_or_else(|| OauthError::Unsupported("the server names no authorization server".into()))?
        .to_owned();
    let scopes = match &challenge.scope {
        Some(scope) => split_scopes(scope),
        None => document
            .get("scopes_supported")
            .and_then(Value::as_array)
            .map(|scopes| {
                scopes
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    };
    Ok(Resource {
        resource,
        authorization_server,
        scopes,
    })
}

/// Reads the authorization server's metadata from the well-known paths in order, checks its
/// issuer is the server asked about, and refuses one without PKCE S256.
pub async fn discover_server(net: &Net, issuer: &str) -> Result<AuthServer, OauthError> {
    let issuer_url = wellknown::checked(issuer).map_err(OauthError::Unsupported)?;
    for candidate in wellknown::authorization_server_metadata(&issuer_url) {
        let Some(document) = get_json(net, &candidate).await? else {
            continue;
        };
        let server: AuthServer = serde_json::from_value(document).map_err(|_| {
            OauthError::Unsupported("the authorization server's metadata is incomplete".into())
        })?;
        if server.issuer.trim_end_matches('/') != issuer.trim_end_matches('/') {
            return Err(OauthError::Unsupported(
                "the authorization server's metadata names a different issuer".into(),
            ));
        }
        // Each may be on another origin, but each must pass the same address rules; the
        // authorization page is opened by the person's browser, never fetched, and is held to
        // them all the same.
        for endpoint in [&server.authorization_endpoint, &server.token_endpoint] {
            net.check(endpoint).await?;
        }
        if let Some(registration) = &server.registration_endpoint {
            net.check(registration).await?;
        }
        let pkce = server
            .code_challenge_methods_supported
            .as_ref()
            .is_some_and(|methods| methods.iter().any(|m| m == "S256"));
        if !pkce {
            return Err(OauthError::Unsupported(
                "the authorization server does not support PKCE, so Spade will not sign in there"
                    .into(),
            ));
        }
        return Ok(server);
    }
    Err(OauthError::Unsupported(
        "the authorization server publishes no metadata".into(),
    ))
}

/// Registers Spade as a public client (RFC 7591) with `redirect`.
pub async fn register(
    net: &Net,
    server: &AuthServer,
    redirect: &str,
) -> Result<Client, OauthError> {
    let Some(endpoint) = &server.registration_endpoint else {
        return Err(OauthError::NeedsClient);
    };
    let body = json!({
        "client_name": "Spade",
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        // The MCP spec asks for it: OpenID servers default to "web", which refuses loopback.
        "application_type": "native",
    });
    let (http, endpoint) = net.client(endpoint).await?;
    let response = http
        .post(endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            OauthError::Network(format!("could not register Spade: {}", short(&error)))
        })?;
    let status = response.status();
    let answer = read_json(response).await?;
    if !status.is_success() {
        return Err(OauthError::Unsupported(format!(
            "the authorization server refused to register Spade{}",
            described(&answer)
        )));
    }
    let id = answer
        .get("client_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| OauthError::Network("the registration gave no client ID".into()))?;
    let secret = answer
        .get("client_secret")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let auth_method = answer
        .get("token_endpoint_auth_method")
        .and_then(Value::as_str)
        .unwrap_or(if secret.is_some() {
            "client_secret_basic"
        } else {
            "none"
        })
        .to_owned();
    Ok(Client {
        id: id.to_owned(),
        secret,
        auth_method,
        registered_redirect: Some(redirect.to_owned()),
        metadata_document: false,
    })
}

/// A client ID the person registered with the app's maker, and its secret if any.
pub fn preregistered(server: &AuthServer, id: &str, secret: Option<String>) -> Client {
    let methods = server.token_endpoint_auth_methods_supported.as_deref();
    let auth_method = match &secret {
        None => "none",
        // RFC 8414: client_secret_basic when the server lists none.
        Some(_) if methods.is_none_or(|m| m.iter().any(|m| m == "client_secret_basic")) => {
            "client_secret_basic"
        }
        Some(_) => "client_secret_post",
    };
    Client {
        id: id.trim().to_owned(),
        secret,
        auth_method: auth_method.to_owned(),
        registered_redirect: None,
        metadata_document: false,
    }
}

/// One sign-in in progress: what the callback is checked against.
#[derive(Clone, PartialEq, Eq)]
pub struct Attempt {
    pub state: String,
    pub verifier: String,
    pub redirect: String,
    pub resource: String,
    pub scopes: Vec<String>,
    pub server: AuthServer,
    pub client: Client,
}

impl std::fmt::Debug for Attempt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Attempt")
            .field("issuer", &self.server.issuer)
            .finish_non_exhaustive()
    }
}

/// The address to open in the person's browser.
pub fn authorization_url(attempt: &Attempt) -> Result<String, OauthError> {
    let mut url = Url::parse(&attempt.server.authorization_endpoint)
        .map_err(|_| OauthError::Unsupported("the authorization address is not valid".into()))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &attempt.client.id)
            .append_pair("redirect_uri", &attempt.redirect)
            .append_pair("code_challenge", &pkce::challenge(&attempt.verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &attempt.state)
            .append_pair("resource", &attempt.resource);
        if !attempt.scopes.is_empty() {
            query.append_pair("scope", &attempt.scopes.join(" "));
        }
    }
    Ok(url.into())
}

/// The scopes to ask for: the server's, plus `offline_access` when the authorization server
/// offers it, so a refresh token comes back.
pub fn with_offline_access(mut scopes: Vec<String>, server: &AuthServer) -> Vec<String> {
    let offered = server
        .scopes_supported
        .as_ref()
        .is_some_and(|s| s.iter().any(|s| s == "offline_access"));
    if offered && !scopes.iter().any(|s| s == "offline_access") {
        scopes.push("offline_access".into());
    }
    scopes
}

/// The RFC 9207 check on the callback's `iss`, by the spec's table. A sign-in as Spade's
/// metadata document needs `iss` whatever the server advertises: that client ID and its callback
/// address are the same at every server, so only `iss` tells their answers apart (the document
/// draft, section 7, makes it mandatory).
pub fn issuer_matches(attempt: &Attempt, iss: Option<&str>) -> bool {
    match iss {
        Some(iss) => iss == attempt.server.issuer,
        None => {
            !attempt.client.metadata_document
                && attempt
                    .server
                    .authorization_response_iss_parameter_supported
                    != Some(true)
        }
    }
}

/// Exchanges the callback's code for tokens.
pub async fn exchange(net: &Net, attempt: &Attempt, code: &str) -> Result<Tokens, OauthError> {
    let form = vec![
        ("grant_type", "authorization_code".to_owned()),
        ("code", code.to_owned()),
        ("redirect_uri", attempt.redirect.clone()),
        ("code_verifier", attempt.verifier.clone()),
        ("resource", attempt.resource.clone()),
    ];
    token_request(net, &attempt.server.token_endpoint, &attempt.client, form).await
}

/// Exchanges a refresh token for new tokens. A refused grant means the person must sign in again.
pub async fn refresh(
    net: &Net,
    token_endpoint: &str,
    client: &Client,
    refresh_token: &str,
    resource: &str,
) -> Result<Tokens, OauthError> {
    let form = vec![
        ("grant_type", "refresh_token".to_owned()),
        ("refresh_token", refresh_token.to_owned()),
        ("resource", resource.to_owned()),
    ];
    token_request(net, token_endpoint, client, form).await
}

async fn token_request(
    net: &Net,
    endpoint: &str,
    client: &Client,
    mut form: Vec<(&'static str, String)>,
) -> Result<Tokens, OauthError> {
    let (http, endpoint) = net.client(endpoint).await?;
    let mut request = http.post(endpoint).header("accept", "application/json");
    match (&client.secret, client.auth_method.as_str()) {
        (Some(secret), "client_secret_basic") => {
            request = request.basic_auth(form_encode(&client.id), Some(form_encode(secret)));
        }
        (Some(secret), _) => {
            form.push(("client_id", client.id.clone()));
            form.push(("client_secret", secret.clone()));
        }
        (None, _) => form.push(("client_id", client.id.clone())),
    }
    let response = request.form(&form).send().await.map_err(|error| {
        OauthError::Network(format!(
            "could not reach the sign-in server: {}",
            short(&error)
        ))
    })?;
    let status = response.status();
    let answer = read_json(response).await?;
    if !status.is_success() {
        let code = answer.get("error").and_then(Value::as_str).unwrap_or("");
        let why = described(&answer);
        return Err(
            if status == StatusCode::BAD_REQUEST || status == StatusCode::UNAUTHORIZED {
                if code.is_empty() {
                    OauthError::Refused(format!("HTTP {status}"))
                } else {
                    OauthError::Refused(format!("{code}{why}"))
                }
            } else {
                OauthError::Network(format!("the sign-in server answered HTTP {status}"))
            },
        );
    }
    let access = answer
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| OauthError::Network("the sign-in server gave no access token".into()))?;
    if let Some(kind) = answer.get("token_type").and_then(Value::as_str)
        && !kind.eq_ignore_ascii_case("bearer")
    {
        return Err(OauthError::Unsupported(format!(
            "the sign-in server gave a {kind} token, not a bearer token"
        )));
    }
    let expires_in = match answer.get("expires_in") {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    };
    Ok(Tokens {
        access: access.to_owned(),
        refresh: answer
            .get("refresh_token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_owned),
        expires_in,
        scope: answer
            .get("scope")
            .and_then(Value::as_str)
            .map(str::to_owned),
        account: answer
            .get("id_token")
            .and_then(Value::as_str)
            .and_then(account_from_id_token),
    })
}

/// RFC 6749 section 2.3.1: the client ID and secret are form-encoded before Basic.
fn form_encode(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// The account an ID token names, for display: email, then user name, then name.
fn account_from_id_token(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    ["email", "preferred_username", "name"]
        .iter()
        .find_map(|key| claims.get(key).and_then(Value::as_str))
        .map(|name| name.chars().filter(|c| !c.is_control()).take(120).collect())
}

pub fn split_scopes(scope: &str) -> Vec<String> {
    scope.split_whitespace().map(str::to_owned).collect()
}

/// A GET for a JSON document. `Ok(None)` when it is not there (any 4xx).
async fn get_json(net: &Net, address: &str) -> Result<Option<Value>, OauthError> {
    let (http, address) = net.client(address).await?;
    let response = http
        .get(address)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|error| {
            OauthError::Network(format!(
                "could not read sign-in metadata: {}",
                short(&error)
            ))
        })?;
    let status = response.status();
    if status.is_client_error() || status.is_redirection() {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(OauthError::Network(format!(
            "sign-in metadata answered HTTP {status}"
        )));
    }
    let value = read_json(response).await?;
    Ok(value.is_object().then_some(value))
}

async fn read_json(mut response: reqwest::Response) -> Result<Value, OauthError> {
    let too_large = || OauthError::Network("the answer is too large".into());
    if response
        .content_length()
        .is_some_and(|n| n > MOST_BYTES as u64)
    {
        return Err(too_large());
    }
    // Counted as it arrives, so an endless or lying answer stops at the limit.
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| OauthError::Network(format!("the answer broke off: {}", short(&error))))?
    {
        if bytes.len() + chunk.len() > MOST_BYTES {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// `: description` from an OAuth error answer, kept short and on one line.
fn described(answer: &Value) -> String {
    answer
        .get("error_description")
        .and_then(Value::as_str)
        .map(|text| {
            let text: String = text.chars().filter(|c| !c.is_control()).take(200).collect();
            format!(": {text}")
        })
        .unwrap_or_default()
}

/// A request error in a few words, without the address (which may carry a query).
fn short(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "it did not answer in time".into()
    } else if error.is_connect() {
        "could not connect".into()
    } else {
        "the request failed".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(iss_supported: Option<bool>) -> AuthServer {
        AuthServer {
            issuer: "https://auth.example.com".into(),
            authorization_endpoint: "https://auth.example.com/authorize?tenant=a".into(),
            token_endpoint: "https://auth.example.com/token".into(),
            registration_endpoint: None,
            code_challenge_methods_supported: Some(vec!["S256".into()]),
            scopes_supported: Some(vec!["read".into(), "offline_access".into()]),
            token_endpoint_auth_methods_supported: None,
            authorization_response_iss_parameter_supported: iss_supported,
            client_id_metadata_document_supported: None,
        }
    }

    fn attempt(iss_supported: Option<bool>) -> Attempt {
        Attempt {
            state: "st".into(),
            verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into(),
            redirect: "http://127.0.0.1:4000/v1/connectors/callback".into(),
            resource: "https://mcp.example.com/mcp".into(),
            scopes: vec!["read".into(), "offline_access".into()],
            server: server(iss_supported),
            client: preregistered(&server(None), "spade-client", None),
        }
    }

    #[test]
    fn the_authorization_address_carries_pkce_state_resource_and_scope() -> Result<(), String> {
        let address = authorization_url(&attempt(None)).map_err(|e| e.to_string())?;
        let url = Url::parse(&address).map_err(|e| e.to_string())?;
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        let get = |key: &str| {
            pairs
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("tenant"), Some("a"), "the endpoint's own query is kept");
        assert_eq!(get("response_type"), Some("code"));
        assert_eq!(get("client_id"), Some("spade-client"));
        assert_eq!(get("code_challenge_method"), Some("S256"));
        assert_eq!(
            get("code_challenge"),
            Some("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        );
        assert_eq!(get("state"), Some("st"));
        assert_eq!(get("resource"), Some("https://mcp.example.com/mcp"));
        assert_eq!(get("scope"), Some("read offline_access"));
        assert_eq!(
            get("code_verifier"),
            None,
            "the verifier never leaves Spade"
        );
        Ok(())
    }

    #[test]
    fn the_issuer_check_follows_rfc_9207() {
        let advertised = attempt(Some(true));
        assert!(issuer_matches(
            &advertised,
            Some("https://auth.example.com")
        ));
        assert!(!issuer_matches(
            &advertised,
            Some("https://evil.example.com")
        ));
        assert!(!issuer_matches(&advertised, None), "advertised but missing");
        let quiet = attempt(None);
        assert!(issuer_matches(&quiet, None));
        assert!(!issuer_matches(&quiet, Some("https://evil.example.com")));
        let mut document = attempt(None);
        document.client = cimd::client("https://acehq.dev/oauth/spade.json");
        assert!(
            !issuer_matches(&document, None),
            "a metadata-document sign-in needs iss even where none is advertised"
        );
        assert!(issuer_matches(&document, Some("https://auth.example.com")));
        assert!(
            !issuer_matches(&quiet, Some("https://AUTH.example.com")),
            "compared as plain strings"
        );
    }

    #[test]
    fn offline_access_is_asked_for_only_when_offered() {
        let scopes = with_offline_access(vec!["read".into()], &server(None));
        assert_eq!(scopes, vec!["read", "offline_access"]);
        let mut no_offline = server(None);
        no_offline.scopes_supported = None;
        assert_eq!(
            with_offline_access(vec![], &no_offline),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_client_secret_goes_by_basic_unless_the_server_only_takes_it_in_the_form() {
        let mut only_post = server(None);
        only_post.token_endpoint_auth_methods_supported = Some(vec!["client_secret_post".into()]);
        assert_eq!(
            preregistered(&only_post, "id", Some("s".into())).auth_method,
            "client_secret_post"
        );
        assert_eq!(
            preregistered(&server(None), "id", Some("s".into())).auth_method,
            "client_secret_basic"
        );
        assert_eq!(preregistered(&server(None), " id ", None).id, "id");
    }

    #[test]
    fn tokens_never_show_in_debug_output() {
        let tokens = Tokens {
            access: "at-secret".into(),
            refresh: Some("rt-secret".into()),
            expires_in: Some(60),
            scope: None,
            account: None,
        };
        let shown = format!("{tokens:?}");
        assert!(!shown.contains("at-secret") && !shown.contains("rt-secret"));
    }

    #[test]
    fn an_id_token_names_the_account_for_display() {
        let claims = URL_SAFE_NO_PAD.encode(br#"{"email":"me@example.com","name":"Me"}"#);
        assert_eq!(
            account_from_id_token(&format!("h.{claims}.s")),
            Some("me@example.com".into())
        );
        assert_eq!(account_from_id_token("not-a-jwt"), None);
    }
}
