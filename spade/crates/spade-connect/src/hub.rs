//! Connecting, the sign-in callback, disconnecting, and each bot's allow list.

use std::sync::Arc;

use serde::Deserialize;
use spade_keys::KeyStore;
use spade_mcp::{McpClient, McpConfig, Secret, ToolsError};

use crate::apps::{self, App, Grant};
use crate::oauth::{self, Attempt, OauthError, pkce, wellknown};
use crate::records::{self, Access, Auth, OauthFacts, Record};
use crate::{Connectors, SIGN_IN_WINDOW_MS, View, lock, secrets};

/// What connecting takes. One of `id` (reconnect), `catalogue` or `url` names the server.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConnectRequest {
    /// An existing connector, to sign in again.
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub catalogue: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// For a server added by URL: the person says it runs on their own machine or network, so
    /// its sign-in may use local addresses. Catalogue servers never are.
    #[serde(default)]
    pub local: bool,
    /// A token or API key, sent as a bearer instead of signing in.
    #[serde(default)]
    pub token: Option<String>,
    /// A client the person registered with the app's maker.
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_secret: Option<String>,
}

/// How connecting went on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Started {
    /// Connected already (a token, or a server that needs no sign-in).
    Connected(View),
    /// Open `url` in the person's browser; the callback finishes the sign-in.
    SignIn { id: String, url: String },
    /// A device sign-in (RFC 8628): the person enters `code` at `url`; Spade polls meanwhile and
    /// the connector's view follows.
    Device {
        id: String,
        code: String,
        url: String,
        expires_in: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConnectError {
    #[error("{0}")]
    Invalid(String),
    #[error("no such connector")]
    NotFound,
    #[error("this app needs a client ID you register with its maker")]
    NeedsClient,
    #[error("this machine has no keychain Spade can use, so it cannot keep a sign-in")]
    NoKeychain,
    #[error("the server refused this token")]
    Refused,
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Unreachable(String),
    #[error("{0}")]
    Failed(String),
}

/// The query a sign-in comes back with.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Callback {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub iss: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// The connector whose callback address it came back to (the path, never the query); `None`
    /// at the shared address of sign-ins as Spade's metadata document.
    #[serde(skip)]
    pub connector: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FinishError {
    /// No sign-in Spade started has this state, or it was used already.
    #[error("this sign-in was not started by Spade, or it was already used")]
    UnknownState,
    #[error("this sign-in took too long; start it again")]
    Expired,
    /// The answer came from a different authorization server than the one asked (RFC 9207).
    #[error("this sign-in came back from the wrong server, so Spade ignored it")]
    WrongIssuer,
    /// The app said no (the person declined, or it refused Spade). What it said is not shown:
    /// its words reach the person's browser on Spade's own page.
    #[error("the sign-in was cancelled or refused")]
    Declined,
    #[error("{0}")]
    Failed(String),
}

/// A sign-in waiting for its callback.
pub(crate) struct Pending {
    pub id: String,
    pub name: String,
    pub url: String,
    pub catalogue: Option<String>,
    pub local: bool,
    pub attempt: Attempt,
    pub started_ms: i64,
    /// Where this sign-in's requests may go, fixed when it started.
    pub net: oauth::Net,
    /// The connector segment its callback address ends in; `None` for the shared address.
    pub back_to: Option<String>,
    /// Signed in with one of Spade's own registered apps.
    pub shipped: bool,
}

/// A finished sign-in, ready to keep: the same for a callback and a device sign-in.
pub(crate) struct SignedIn {
    pub id: String,
    pub name: String,
    pub url: String,
    pub catalogue: Option<String>,
    pub local: bool,
    pub issuer: String,
    pub token_endpoint: String,
    pub resource: String,
    pub client: oauth::Client,
    pub shipped: bool,
    pub scopes: Vec<String>,
    pub tokens: oauth::Tokens,
}

/// Which server a request is about.
pub(crate) struct Target {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) url: url::Url,
    pub(crate) catalogue: Option<String>,
    /// Marked local by the person (see [`ConnectRequest::local`]).
    pub(crate) local: bool,
    pub(crate) existing: Option<Record>,
}

impl Connectors {
    /// Connects a server: with a token at once, else by starting a sign-in.
    pub async fn connect(
        self: &Arc<Self>,
        request: ConnectRequest,
    ) -> Result<Started, ConnectError> {
        let target = self.target(&request)?;
        // Local addresses only for a connector the person marked local; the server's own
        // address is held to the same rules as everything its sign-in names.
        let net = self.addresses.for_connector(target.local, self.timeout);
        net.check(target.url.as_str()).await.map_err(from_oauth)?;
        if let Some(token) = request
            .token
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            return self.connect_with_token(target, token.to_owned()).await;
        }
        let challenge = oauth::probe(&net, &target.url).await.map_err(from_oauth)?;
        let Some(challenge) = challenge else {
            return self.connect_open(target).await;
        };
        let keys = self.keys.clone().ok_or(ConnectError::NoKeychain)?;
        let callback = self
            .redirect
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| ConnectError::Failed("Spade is not listening yet".into()))?;
        let resource = oauth::discover_resource(&net, &target.url, &challenge)
            .await
            .map_err(from_oauth)?;
        let server = oauth::discover_server(&net, &resource.authorization_server)
            .await
            .map_err(from_oauth)?;
        let shipped = self.shipped_app(&target, &request, &server)?;
        if let Some(app) = shipped.filter(|app| app.grant == Grant::Device) {
            return self.start_device(net, target, resource, server, app).await;
        }
        oauth::require_pkce(&server).map_err(from_oauth)?;
        let (client, redirect) = match shipped {
            // Spade's own app: public, PKCE, its catalogue entry's callback on any loopback port.
            Some(app) => (
                oauth::Client {
                    id: app.client_id.clone(),
                    secret: None,
                    auth_method: "none".into(),
                    registered_redirect: None,
                    metadata_document: false,
                },
                format!("{callback}/{}", app.connector),
            ),
            None => {
                self.client_for(&net, &keys, &target, &request, &server, &callback)
                    .await?
            }
        };
        let back_to = redirect
            .strip_prefix(&format!("{callback}/"))
            .map(str::to_owned);
        let scopes = match shipped.and_then(|app| app.scopes.clone()) {
            Some(scopes) => scopes,
            None => oauth::with_offline_access(resource.scopes, &server),
        };
        let random = self.random.as_ref();
        let attempt = Attempt {
            state: pkce::random_value(random).map_err(ConnectError::Failed)?,
            verifier: pkce::random_value(random).map_err(ConnectError::Failed)?,
            redirect,
            resource: resource.resource,
            scopes,
            server,
            client,
        };
        let address = oauth::authorization_url(&attempt).map_err(from_oauth)?;
        let now = self.now();
        let mut pending = lock(&self.pending);
        // One sign-in per connector: a newer one replaces an older one, and stale ones go.
        pending.retain(|_, p| p.id != target.id && now - p.started_ms < SIGN_IN_WINDOW_MS);
        self.drop_device(&target.id);
        pending.insert(
            attempt.state.clone(),
            Pending {
                id: target.id.clone(),
                name: target.name,
                url: target.url.to_string(),
                catalogue: target.catalogue,
                local: target.local,
                attempt,
                started_ms: now,
                net,
                back_to,
                shipped: shipped.is_some(),
            },
        );
        Ok(Started::SignIn {
            id: target.id,
            url: address,
        })
    }

    /// Finishes a sign-in from its callback. The state must be one Spade started, unused and
    /// recent, and the issuer the one asked; only then is the code exchanged.
    pub async fn finish(self: &Arc<Self>, callback: Callback) -> Result<View, FinishError> {
        let state = callback.state.as_deref().unwrap_or("");
        let pending = lock(&self.pending)
            .remove(state)
            .ok_or(FinishError::UnknownState)?;
        let epoch = self.epoch(&pending.id);
        if self.now() - pending.started_ms >= SIGN_IN_WINDOW_MS {
            return Err(FinishError::Expired);
        }
        // Back at another connector's address, or at the shared one when this sign-in has its
        // own (or the reverse): an answer mixed up between servers.
        if callback.connector != pending.back_to {
            return Err(FinishError::WrongIssuer);
        }
        if !oauth::issuer_matches(&pending.attempt, callback.iss.as_deref()) {
            return Err(FinishError::WrongIssuer);
        }
        if callback.error.is_some() {
            return Err(FinishError::Declined);
        }
        let code = callback
            .code
            .filter(|c| !c.is_empty())
            .ok_or_else(|| FinishError::Failed("the sign-in came back without a code".into()))?;
        if self.keys.is_none() {
            return Err(FinishError::Failed(ConnectError::NoKeychain.to_string()));
        }
        let tokens = oauth::exchange(&pending.net, &pending.attempt, &code)
            .await
            .map_err(|error| {
                // Fixed words only: the token endpoint's own text never reaches the page.
                FinishError::Failed(
                    match error {
                        OauthError::Refused(_) => "the app refused the sign-in",
                        OauthError::Network(_) => "Spade could not reach the app's sign-in server",
                        OauthError::Unsupported(_) | OauthError::NeedsClient => {
                            "the app's sign-in server answered something Spade could not use"
                        }
                    }
                    .into(),
                )
            })?;
        let client = pending.attempt.client.clone();
        let signed = SignedIn {
            id: pending.id,
            name: pending.name,
            url: pending.url,
            catalogue: pending.catalogue,
            local: pending.local,
            issuer: pending.attempt.server.issuer,
            token_endpoint: pending.attempt.server.token_endpoint,
            resource: pending.attempt.resource,
            client,
            shipped: pending.shipped,
            scopes: pending.attempt.scopes,
            tokens,
        };
        self.keep_sign_in(signed, epoch)
            .await
            .map_err(FinishError::Failed)
    }

    /// Keeps a finished sign-in: its secrets in the keychain, the rest in the record, then a new
    /// session. A disconnect since `epoch` wins, and nothing is written.
    pub(crate) async fn keep_sign_in(
        self: &Arc<Self>,
        signed: SignedIn,
        epoch: u64,
    ) -> Result<View, String> {
        let keys = self
            .keys
            .clone()
            .ok_or_else(|| ConnectError::NoKeychain.to_string())?;
        let id = signed.id.clone();
        let _writing = self.writes.lock().await;
        if self.epoch(&id) != epoch {
            return Err("the app was disconnected meanwhile".into());
        }
        let tokens = signed.tokens;
        secrets::put(&keys, &id, secrets::ACCESS, Some(tokens.access.clone())).await?;
        secrets::put(&keys, &id, secrets::REFRESH, tokens.refresh.clone()).await?;
        let client = signed.client;
        // A shipped app is public: it has no secret, and any kept from an earlier client goes.
        let secret = if signed.shipped {
            None
        } else {
            client.secret.clone()
        };
        secrets::put(&keys, &id, secrets::CLIENT_SECRET, secret).await?;
        let existing = self.record(&id);
        let record = Record {
            id: id.clone(),
            name: signed.name,
            url: signed.url,
            catalogue: signed.catalogue,
            local: signed.local,
            auth: Auth::Oauth(OauthFacts {
                issuer: signed.issuer,
                token_endpoint: signed.token_endpoint,
                resource: signed.resource,
                client_id: client.id.clone(),
                client_auth: client.auth_method.clone(),
                registered_redirect: client.registered_redirect.clone(),
                shipped: signed.shipped,
                scopes: signed.scopes,
                expires_at_ms: tokens.expires_in.map(|s| self.now() + seconds_ms(s)),
            }),
            account: tokens
                .account
                .or_else(|| existing.as_ref().and_then(|r| r.account.clone())),
            needs_reconnect: false,
            added_ms: existing.map_or_else(|| self.now(), |r| r.added_ms),
        };
        self.put_record(record)?;
        self.restart_session(&id);
        self.get(&id)
            .ok_or_else(|| "the connector went away".to_owned())
    }

    /// Forgets a connector: its session, its secrets, and every bot's permission for it.
    pub async fn disconnect(&self, id: &str) -> Result<bool, String> {
        let _writing = self.writes.lock().await;
        self.next_epoch(id);
        let had_pending = {
            let mut pending = lock(&self.pending);
            let before = pending.len();
            pending.retain(|_, p| p.id != id);
            before != pending.len()
        } | self.drop_device(id);
        let removed = {
            let mut records = lock(&self.records);
            let next: Vec<Record> = records.iter().filter(|r| r.id != id).cloned().collect();
            let removed = next.len() != records.len();
            if removed {
                records::save(&self.store, &next)?;
                *records = next;
            }
            removed
        };
        self.stop_session(id);
        {
            let mut access = lock(&self.access);
            let mut next = access.clone();
            for allowed in next.values_mut() {
                if let Access::Only(ids) = allowed {
                    ids.remove(id);
                }
            }
            if next != *access {
                records::save_access(&self.store, &next)?;
                *access = next;
            }
        }
        if removed && let Some(keys) = &self.keys {
            secrets::forget_all(keys, id).await?;
        }
        Ok(removed || had_pending)
    }

    /// What a bot may use: what the person set, else the default for its kind.
    pub fn access(&self, agent: &str, is_main: bool) -> Access {
        lock(&self.access)
            .get(agent)
            .cloned()
            .unwrap_or_else(|| Access::default_for(is_main))
    }

    /// Sets what a bot may use. Every named connector must exist.
    pub fn set_access(&self, agent: &str, access: Access) -> Result<(), ConnectError> {
        if let Access::Only(ids) = &access {
            let records = lock(&self.records);
            if let Some(unknown) = ids.iter().find(|id| !records.iter().any(|r| &&r.id == id)) {
                return Err(ConnectError::Invalid(format!(
                    "no connector named {unknown}"
                )));
            }
        }
        let mut current = lock(&self.access);
        let mut next = current.clone();
        next.insert(agent.to_owned(), access);
        records::save_access(&self.store, &next).map_err(ConnectError::Failed)?;
        *current = next;
        Ok(())
    }

    /// Forgets a deleted bot's allow list.
    pub fn forget_agent(&self, agent: &str) -> Result<(), String> {
        let mut current = lock(&self.access);
        if !current.contains_key(agent) {
            return Ok(());
        }
        let mut next = current.clone();
        next.remove(agent);
        records::save_access(&self.store, &next)?;
        *current = next;
        Ok(())
    }

    fn target(&self, request: &ConnectRequest) -> Result<Target, ConnectError> {
        if let Some(id) = &request.id {
            let Some(existing) = self.record(id) else {
                // A device sign-in that ended before it connected is tried again from its row.
                return self.device_target(id).ok_or(ConnectError::NotFound);
            };
            let url = wellknown::checked(&existing.url).map_err(ConnectError::Invalid)?;
            return Ok(Target {
                id: existing.id.clone(),
                name: existing.name.clone(),
                url,
                catalogue: existing.catalogue.clone(),
                local: existing.local,
                existing: Some(existing),
            });
        }
        if let Some(catalogue) = &request.catalogue {
            let entry = self
                .catalogue
                .iter()
                .find(|e| &e.id == catalogue)
                .ok_or_else(|| ConnectError::Invalid(format!("no catalogue entry {catalogue}")))?;
            let url = wellknown::checked(&entry.url).map_err(ConnectError::Invalid)?;
            return Ok(Target {
                id: entry.id.clone(),
                name: entry.name.clone(),
                url,
                catalogue: Some(entry.id.clone()),
                local: false,
                existing: self.record(&entry.id),
            });
        }
        let address = request
            .url
            .as_deref()
            .ok_or_else(|| ConnectError::Invalid("name a catalogue entry or a URL".into()))?;
        let url = wellknown::checked(address).map_err(ConnectError::Invalid)?;
        let host = url.host_str().unwrap_or("server").to_owned();
        // The same address again is the same connector.
        if let Some(existing) = lock(&self.records).iter().find(|r| r.url == url.as_str()) {
            return Ok(Target {
                id: existing.id.clone(),
                name: existing.name.clone(),
                url,
                catalogue: existing.catalogue.clone(),
                local: existing.catalogue.is_none() && request.local,
                existing: Some(existing.clone()),
            });
        }
        let name = request
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(|n| n.chars().take(60).collect())
            .unwrap_or_else(|| host.clone());
        Ok(Target {
            id: self.free_id(&slug(&host)),
            name,
            url,
            catalogue: None,
            local: request.local,
            existing: None,
        })
    }

    fn free_id(&self, base: &str) -> String {
        let taken = |id: &str| {
            self.catalogue.iter().any(|e| e.id == id)
                || lock(&self.records).iter().any(|r| r.id == id)
                || lock(&self.pending).values().any(|p| p.id == id)
        };
        if !taken(base) {
            return base.to_owned();
        }
        (2..)
            .map(|n| format!("{base}-{n}"))
            .find(|id| !taken(id))
            .unwrap_or_default()
    }

    /// The OAuth client to sign in as and the callback address it comes back to, in the MCP
    /// spec's order: one the person gave (now, or before for this issuer); Spade's metadata
    /// document where the server fetches them; the one Spade registered before if its redirect
    /// still matches; else a fresh registration. `callback` is Spade's shared callback address.
    async fn client_for(
        &self,
        net: &oauth::Net,
        keys: &KeyStore,
        target: &Target,
        request: &ConnectRequest,
        server: &oauth::AuthServer,
        callback: &str,
    ) -> Result<(oauth::Client, String), ConnectError> {
        // The connector's own callback address: ids are lower-case letters, digits and dashes.
        let own = format!("{callback}/{}", target.id);
        if let Some(id) = request
            .client_id
            .as_deref()
            .map(str::trim)
            .filter(|i| !i.is_empty())
        {
            let secret = request
                .client_secret
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            return Ok((oauth::preregistered(server, id, secret), own));
        }
        let document = self.client_metadata.as_deref();
        let stored = match &target.existing {
            Some(Record {
                auth: Auth::Oauth(facts),
                ..
            }) if facts.issuer == server.issuer
                && !facts.shipped
                && Some(facts.client_id.as_str()) != document =>
            {
                Some(facts)
            }
            _ => None,
        };
        // A client the person gave earlier: never registered by Spade.
        if let Some(facts) = stored.filter(|f| f.registered_redirect.is_none()) {
            return Ok((reused(keys, &target.id, facts).await?, own));
        }
        // The document lists only the shared loopback address, any port.
        if let Some(document) = document
            && oauth::cimd::usable(server)
            && callback.starts_with("http://127.0.0.1:")
        {
            return Ok((oauth::cimd::client(document), callback.to_owned()));
        }
        if let Some(facts) = stored.filter(|f| f.registered_redirect.as_deref() == Some(&own)) {
            return Ok((reused(keys, &target.id, facts).await?, own));
        }
        let client = oauth::register(net, server, &own)
            .await
            .map_err(from_oauth)?;
        Ok((client, own))
    }

    /// Spade's own app for this sign-in, unless the person brings their own client (now, or
    /// before for this issuer). A client secret sent for Spade's app is refused: it is public.
    fn shipped_app(
        &self,
        target: &Target,
        request: &ConnectRequest,
        server: &oauth::AuthServer,
    ) -> Result<Option<&App>, ConnectError> {
        let Some(app) = apps::for_issuer(&self.apps, &server.issuer) else {
            return Ok(None);
        };
        let given = |value: &Option<String>| {
            value
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        let (client_id, secret) = (given(&request.client_id), given(&request.client_secret));
        if secret.is_some() && client_id.as_deref().is_none_or(|id| id == app.client_id) {
            return Err(ConnectError::Invalid(format!(
                "Spade's own sign-in for {} is public and takes no client secret",
                target.name
            )));
        }
        if client_id.is_some() {
            return Ok(None);
        }
        let own_before = matches!(
            &target.existing,
            Some(Record { auth: Auth::Oauth(facts), .. })
                if facts.issuer == server.issuer
                    && !facts.shipped
                    && facts.registered_redirect.is_none()
                    && Some(facts.client_id.as_str()) != self.client_metadata.as_deref()
        );
        Ok((!own_before).then_some(app))
    }

    async fn connect_with_token(
        self: &Arc<Self>,
        target: Target,
        token: String,
    ) -> Result<Started, ConnectError> {
        let keys = self.keys.clone().ok_or(ConnectError::NoKeychain)?;
        let epoch = self.epoch(&target.id);
        let client = McpClient::new(
            McpConfig::new(target.url.as_str(), self.timeout).bearer(Secret::new(token.clone())),
        );
        let tools = match client.tools().await {
            Ok(tools) => tools,
            Err(ToolsError::Refused) => return Err(ConnectError::Refused),
            Err(error) => return Err(ConnectError::Unreachable(error.to_string())),
        };
        let _writing = self.writes.lock().await;
        if self.epoch(&target.id) != epoch {
            return Err(ConnectError::Failed(
                "the app was disconnected meanwhile".into(),
            ));
        }
        secrets::put(&keys, &target.id, secrets::ACCESS, Some(token))
            .await
            .map_err(ConnectError::Failed)?;
        for kind in [secrets::REFRESH, secrets::CLIENT_SECRET] {
            secrets::put(&keys, &target.id, kind, None)
                .await
                .map_err(ConnectError::Failed)?;
        }
        self.save_connected(target, Auth::Token, client, tools)
    }

    async fn connect_open(self: &Arc<Self>, target: Target) -> Result<Started, ConnectError> {
        let epoch = self.epoch(&target.id);
        let client = McpClient::new(McpConfig::new(target.url.as_str(), self.timeout));
        let tools = client
            .tools()
            .await
            .map_err(|e| ConnectError::Unreachable(e.to_string()))?;
        let _writing = self.writes.lock().await;
        if self.epoch(&target.id) != epoch {
            return Err(ConnectError::Failed(
                "the app was disconnected meanwhile".into(),
            ));
        }
        if let Some(keys) = &self.keys {
            secrets::forget_all(keys, &target.id)
                .await
                .map_err(ConnectError::Failed)?;
        }
        self.save_connected(target, Auth::None, client, tools)
    }

    fn save_connected(
        self: &Arc<Self>,
        target: Target,
        auth: Auth,
        client: McpClient,
        tools: Vec<spade_mcp::McpTool>,
    ) -> Result<Started, ConnectError> {
        let record = Record {
            id: target.id.clone(),
            name: target.name,
            url: target.url.to_string(),
            catalogue: target.catalogue,
            local: target.local,
            auth,
            account: None,
            needs_reconnect: false,
            added_ms: target.existing.map_or_else(|| self.now(), |r| r.added_ms),
        };
        self.put_record(record).map_err(ConnectError::Failed)?;
        self.adopt_session(&target.id, client, tools);
        let view = self
            .get(&target.id)
            .ok_or_else(|| ConnectError::Failed("the connector went away".into()))?;
        Ok(Started::Connected(view))
    }

    pub(crate) fn mark_needs_reconnect(&self, id: &str) {
        if let Some(mut record) = self.record(id)
            && !record.needs_reconnect
        {
            record.needs_reconnect = true;
            if let Err(error) = self.update_record(record) {
                tracing::error!(%error, connector = id, "could not store that a sign-in expired");
            }
        }
    }
}

/// A client stored with a connector, its secret read back from the keychain.
async fn reused(
    keys: &KeyStore,
    id: &str,
    facts: &OauthFacts,
) -> Result<oauth::Client, ConnectError> {
    let secret = secrets::get(keys, id, secrets::CLIENT_SECRET)
        .await
        .map_err(ConnectError::Failed)?;
    Ok(oauth::Client {
        id: facts.client_id.clone(),
        secret,
        auth_method: facts.client_auth.clone(),
        registered_redirect: facts.registered_redirect.clone(),
        metadata_document: false,
    })
}

/// `mcp.example.com` → `mcp-example-com`.
fn slug(host: &str) -> String {
    let slug: String = host
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug.trim_matches('-').chars().take(40).collect::<String>();
    if slug.is_empty() {
        "server".into()
    } else {
        slug
    }
}

pub(crate) fn seconds_ms(seconds: u64) -> i64 {
    i64::try_from(seconds.saturating_mul(1000)).unwrap_or(i64::MAX)
}

pub(crate) fn from_oauth(error: OauthError) -> ConnectError {
    match error {
        OauthError::NeedsClient => ConnectError::NeedsClient,
        OauthError::Unsupported(why) => ConnectError::Unsupported(why),
        OauthError::Refused(why) => ConnectError::Failed(format!("the sign-in was refused: {why}")),
        OauthError::Network(why) => ConnectError::Unreachable(why),
    }
}
