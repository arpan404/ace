//! Each connector's live session: a keeper task that opens it, lists its tools and follows the
//! server's list changes; renewing an expired sign-in; and running calls. A call is sent at most
//! once: one refused before it ran says it is safe to retry, one cut off after sending says its
//! outcome is unknown.

use std::sync::Arc;
use std::time::Duration;

use spade_mcp::{McpClient, McpConfig, McpTool, McpToolResult, Secret, ToolsError};
use tokio::sync::Notify;

use crate::oauth::{self, OauthError};
use crate::records::{Auth, Record};
use crate::{Connectors, lock, secrets};

/// How often a live session's tool list is read again without being told it changed, unless
/// [`crate::Setup::relist`] says otherwise.
pub const RELIST: Duration = Duration::from_secs(10 * 60);
/// Renew an access token this long before it expires.
const RENEW_AHEAD_MS: i64 = 60_000;
const FIRST_RETRY: Duration = Duration::from_secs(2);
const LONGEST_RETRY: Duration = Duration::from_secs(5 * 60);

/// One of a connector's tools, as a bot may be offered it.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectorTool {
    pub connector: String,
    pub connector_name: String,
    /// `<connector>__<tool>`: unique across connectors and ace's own tools.
    pub name: String,
    /// The server's own tool, with its own name.
    pub tool: McpTool,
}

/// Why a call returned no result.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CallError {
    /// It did not run; trying again is safe.
    #[error("{0}")]
    NotRun(String),
    /// It was sent and may have run.
    #[error("{0}")]
    MaybeRan(String),
    /// The sign-in expired and could not be renewed: the person must reconnect.
    #[error(
        "the sign-in to {0} expired; ask the person to reconnect it in Settings, Spade, Connectors"
    )]
    NeedsReconnect(String),
    /// The server refused the request (an unknown tool, bad arguments).
    #[error("{0}")]
    Failed(String),
}

/// What a connector's client sends and what it keeps out of every answer.
#[derive(Default)]
pub(crate) struct Credentials {
    pub(crate) access: Option<String>,
    /// Refresh token, client secret: never sent to the server, redacted all the same.
    pub(crate) others: Vec<String>,
}

impl Credentials {
    pub(crate) fn config(self, url: String, timeout: Duration) -> McpConfig {
        let mut config = McpConfig::new(url, timeout);
        if let Some(access) = self.access {
            config = config.bearer(Secret::new(access));
        }
        for other in self.others {
            config = config.redacting(Secret::new(other));
        }
        config
    }
}

/// Why a client could not be had.
enum Unready {
    NeedsReconnect,
    Other(String),
}

/// The separator between a connector's id and its tool's name.
pub const SEPARATOR: &str = "__";

impl Connectors {
    /// The tools of every connector `allowed` says yes to, in name order.
    pub fn tools_where(&self, allowed: impl Fn(&str) -> bool) -> Vec<ConnectorTool> {
        let records = lock(&self.records).clone();
        let live = self.live.read().unwrap_or_else(|p| p.into_inner());
        let mut tools = Vec::new();
        for record in records.iter().filter(|r| allowed(&r.id)) {
            let Some(session) = live.get(&record.id) else {
                continue;
            };
            for tool in &session.tools {
                tools.push(ConnectorTool {
                    connector: record.id.clone(),
                    connector_name: record.name.clone(),
                    name: format!("{}{SEPARATOR}{}", record.id, tool.name),
                    tool: tool.clone(),
                });
            }
        }
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        tools
    }

    /// The tools a bot may use.
    pub fn tools_for(&self, agent: &str, is_main: bool) -> Vec<ConnectorTool> {
        let access = self.access(agent, is_main);
        self.tools_where(|id| access.allows(id))
    }

    /// Runs `tool` (the server's own name) on `connector`.
    pub async fn call(
        self: &Arc<Self>,
        connector: &str,
        tool: &str,
        arguments: serde_json::Value,
    ) -> Result<McpToolResult, CallError> {
        let record = self
            .record(connector)
            .ok_or_else(|| CallError::NotRun(format!("{connector} is not connected")))?;
        if record.needs_reconnect {
            return Err(CallError::NeedsReconnect(record.name));
        }
        let (client, generation) = match self.client(&record).await {
            Ok(ready) => ready,
            Err(Unready::NeedsReconnect) => {
                self.expire(&record);
                return Err(CallError::NeedsReconnect(record.name));
            }
            Err(Unready::Other(why)) => return Err(CallError::NotRun(why)),
        };
        match client.call(tool, arguments).await {
            Ok(result) => Ok(result),
            // Refused before it ran: renew the sign-in for the next try, never resend this one.
            Err(ToolsError::Refused) => match self.renew(&record, generation).await {
                Ok(()) => Err(CallError::NotRun(format!(
                    "the sign-in to {} had expired and is now renewed",
                    record.name
                ))),
                Err(Unready::NeedsReconnect) => {
                    self.expire(&record);
                    Err(CallError::NeedsReconnect(record.name))
                }
                Err(Unready::Other(why)) => Err(CallError::NotRun(why)),
            },
            Err(ToolsError::NotRun(why) | ToolsError::Unavailable(why)) => Err(CallError::NotRun(
                format!("{} could not be reached: {why}", record.name),
            )),
            Err(
                error @ (ToolsError::OutcomeUnknown(_)
                | ToolsError::Timeout
                | ToolsError::Protocol(_)),
            ) => Err(CallError::MaybeRan(error.to_string())),
            Err(ToolsError::Server { message, .. }) => Err(CallError::Failed(format!(
                "{} refused the call: {message}",
                record.name
            ))),
            Err(ToolsError::InvalidArguments) => Err(CallError::Failed(
                "tool arguments must be a JSON object".into(),
            )),
        }
    }

    /// Starts (or restarts) the keeper for `id`.
    pub(crate) fn keep(self: &Arc<Self>, id: &str) {
        let this = self.clone();
        let owned = id.to_owned();
        let task = tokio::spawn(async move { this.run_keeper(&owned).await });
        if let Some(old) = lock(&self.keepers).insert(id.to_owned(), task.abort_handle()) {
            old.abort();
        }
    }

    /// Drops the session (keeping the tools listed) and keeps it afresh.
    pub(crate) fn restart_session(self: &Arc<Self>, id: &str) {
        {
            let mut live = self.live.write().unwrap_or_else(|p| p.into_inner());
            let session = live.entry(id.to_owned()).or_default();
            // Dropped, never closed: a call already holding it still goes out on it.
            session.client = None;
            session.generation += 1;
            session.problem = None;
        }
        self.keep(id);
    }

    /// Takes over a session opened while connecting, with its tool list.
    pub(crate) fn adopt_session(
        self: &Arc<Self>,
        id: &str,
        client: McpClient,
        tools: Vec<McpTool>,
    ) {
        {
            let mut live = self.live.write().unwrap_or_else(|p| p.into_inner());
            let session = live.entry(id.to_owned()).or_default();
            session.client = Some(Arc::new(client));
            session.tools = tools;
            session.generation += 1;
            session.problem = None;
        }
        self.keep(id);
    }

    pub(crate) fn stop_session(&self, id: &str) {
        if let Some(task) = lock(&self.keepers).remove(id) {
            task.abort();
        }
        let session = self
            .live
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
        if let Some(client) = session.and_then(|s| s.client) {
            client.close();
        }
    }

    async fn run_keeper(self: &Arc<Self>, id: &str) {
        let mut wait = FIRST_RETRY;
        // Set when the timer ran out: the next listing asks the server, never the cache.
        let mut fresh = false;
        loop {
            let Some(record) = self.record(id) else {
                return;
            };
            if record.needs_reconnect {
                return;
            }
            let wake = self.wake(id);
            let listed = match self.client(&record).await {
                Err(Unready::NeedsReconnect) => {
                    self.expire(&record);
                    return;
                }
                Err(Unready::Other(why)) => Err((why, None)),
                Ok((client, generation)) => match if std::mem::take(&mut fresh) {
                    client.fresh_tools().await
                } else {
                    client.tools().await
                } {
                    Ok(tools) => Ok((client, tools)),
                    Err(ToolsError::Refused) => Err(("refused".into(), Some(generation))),
                    Err(error) => Err((error.to_string(), None)),
                },
            };
            match listed {
                Ok((client, tools)) => {
                    wait = FIRST_RETRY;
                    let mut changes = client.changes();
                    self.set_tools(id, tools);
                    tokio::select! {
                        _ = changes.changed() => {}
                        () = tokio::time::sleep(self.relist) => fresh = true,
                        () = wake.notified() => {}
                    }
                }
                Err((_, Some(generation))) => match self.renew(&record, generation).await {
                    Ok(()) => {}
                    Err(Unready::NeedsReconnect) => {
                        self.expire(&record);
                        return;
                    }
                    Err(Unready::Other(why)) => {
                        self.set_problem(id, why);
                        wait = self.pause(&wake, wait).await;
                    }
                },
                Err((why, None)) => {
                    tracing::info!(connector = id, problem = %why, "connector unreachable");
                    self.set_problem(id, why);
                    self.drop_client(id);
                    wait = self.pause(&wake, wait).await;
                }
            }
        }
    }

    async fn pause(&self, wake: &Notify, wait: Duration) -> Duration {
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            () = wake.notified() => {}
        }
        (wait * 2).min(LONGEST_RETRY)
    }

    /// The connector's client, opened with its current credential, renewed first when its
    /// access token is about to expire; and the generation it belongs to.
    async fn client(&self, record: &Record) -> Result<(Arc<McpClient>, u64), Unready> {
        let (existing, generation) = {
            let live = self.live.read().unwrap_or_else(|p| p.into_inner());
            let session = live.get(&record.id);
            (
                session.and_then(|s| s.client.clone()),
                session.map_or(0, |s| s.generation),
            )
        };
        let expiring = match &record.auth {
            Auth::Oauth(facts) => facts
                .expires_at_ms
                .is_some_and(|at| at - self.now() < RENEW_AHEAD_MS),
            _ => false,
        };
        if expiring {
            self.renew(record, generation).await?;
            return self
                .current_client(&record.id)
                .ok_or_else(|| Unready::Other("the renewed session went away".into()));
        }
        if let Some(client) = existing {
            return Ok((client, generation));
        }
        let credentials = match &record.auth {
            Auth::None => Credentials::default(),
            Auth::Token | Auth::Oauth(_) => {
                let keys = self.keys.as_ref().ok_or(Unready::NeedsReconnect)?;
                let access = match secrets::get(keys, &record.id, secrets::ACCESS).await {
                    Ok(Some(token)) => token,
                    Ok(None) => return Err(Unready::NeedsReconnect),
                    Err(why) => return Err(Unready::Other(why)),
                };
                // Never sent to the server, but redacted from what it answers all the same.
                let mut others = Vec::new();
                for kind in [secrets::REFRESH, secrets::CLIENT_SECRET] {
                    if let Some(secret) = secrets::get(keys, &record.id, kind)
                        .await
                        .map_err(Unready::Other)?
                    {
                        others.push(secret);
                    }
                }
                Credentials {
                    access: Some(access),
                    others,
                }
            }
        };
        Ok(self.install_client(&record.id, credentials))
    }

    fn current_client(&self, id: &str) -> Option<(Arc<McpClient>, u64)> {
        let live = self.live.read().unwrap_or_else(|p| p.into_inner());
        let session = live.get(id)?;
        Some((session.client.clone()?, session.generation))
    }

    /// Puts a client with `token` in place, unless one is there already (a renewal may have
    /// installed one meanwhile).
    fn install_client(&self, id: &str, credentials: Credentials) -> (Arc<McpClient>, u64) {
        let url = self.record(id).map(|r| r.url).unwrap_or_default();
        let mut live = self.live.write().unwrap_or_else(|p| p.into_inner());
        let session = live.entry(id.to_owned()).or_default();
        if let Some(client) = &session.client {
            return (client.clone(), session.generation);
        }
        let client = Arc::new(McpClient::new(credentials.config(url, self.timeout)));
        session.client = Some(client.clone());
        (client, session.generation)
    }

    /// Renews an OAuth sign-in with its refresh token, once however many callers ask: one that
    /// saw an older generation finds it renewed already.
    async fn renew(&self, record: &Record, seen: u64) -> Result<(), Unready> {
        let _one = self.renewing.lock().await;
        let generation = self
            .live
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(&record.id)
            .map_or(0, |s| s.generation);
        if generation != seen {
            return Ok(());
        }
        let epoch = self.epoch(&record.id);
        // Read again under the lock: an earlier renewal may have stored new facts.
        let record = self
            .record(&record.id)
            .ok_or_else(|| Unready::Other("disconnected".into()))?;
        let Auth::Oauth(mut facts) = record.auth.clone() else {
            // A token or open server that refuses has nothing to renew with.
            return Err(Unready::NeedsReconnect);
        };
        let keys = self.keys.as_ref().ok_or(Unready::NeedsReconnect)?;
        let refresh = secrets::get(keys, &record.id, secrets::REFRESH)
            .await
            .map_err(Unready::Other)?
            .ok_or(Unready::NeedsReconnect)?;
        let secret = secrets::get(keys, &record.id, secrets::CLIENT_SECRET)
            .await
            .map_err(Unready::Other)?;
        let client = oauth::Client {
            id: facts.client_id.clone(),
            secret,
            auth_method: facts.client_auth.clone(),
            registered_redirect: facts.registered_redirect.clone(),
        };
        let tokens = match oauth::refresh(
            &self.http,
            &facts.token_endpoint,
            &client,
            &refresh,
            &facts.resource,
        )
        .await
        {
            Ok(tokens) => tokens,
            Err(OauthError::Refused(_) | OauthError::NeedsClient) => {
                return Err(Unready::NeedsReconnect);
            }
            Err(error) => return Err(Unready::Other(error.to_string())),
        };
        // Written only if nothing disconnected it while the refresh was out.
        let _writing = self.writes.lock().await;
        if self.epoch(&record.id) != epoch || self.record(&record.id).is_none() {
            return Err(Unready::Other("disconnected".into()));
        }
        secrets::put(
            keys,
            &record.id,
            secrets::ACCESS,
            Some(tokens.access.clone()),
        )
        .await
        .map_err(Unready::Other)?;
        // A server that rotates refresh tokens sends a new one; one that doesn't keeps the old.
        if let Some(rotated) = tokens.refresh.clone() {
            secrets::put(keys, &record.id, secrets::REFRESH, Some(rotated))
                .await
                .map_err(Unready::Other)?;
        }
        facts.expires_at_ms = tokens
            .expires_in
            .map(|s| self.now() + crate::hub::seconds_ms(s));
        let mut renewed = record.clone();
        renewed.auth = Auth::Oauth(facts);
        if !self.update_record(renewed).map_err(Unready::Other)? {
            return Err(Unready::Other("disconnected".into()));
        }
        let wake = {
            let mut live = self.live.write().unwrap_or_else(|p| p.into_inner());
            let session = live.entry(record.id.clone()).or_default();
            // The old client is dropped, not closed: a call on it still completes.
            session.generation += 1;
            let credentials = Credentials {
                access: Some(tokens.access),
                others: [Some(refresh), tokens.refresh, client.secret]
                    .into_iter()
                    .flatten()
                    .collect(),
            };
            let config = credentials.config(record.url.clone(), self.timeout);
            session.client = Some(Arc::new(McpClient::new(config)));
            session.wake.clone()
        };
        wake.notify_one();
        Ok(())
    }

    fn expire(&self, record: &Record) {
        tracing::info!(connector = %record.id, "connector sign-in expired; it needs reconnecting");
        self.mark_needs_reconnect(&record.id);
        self.drop_client(&record.id);
    }

    fn wake(&self, id: &str) -> Arc<Notify> {
        let mut live = self.live.write().unwrap_or_else(|p| p.into_inner());
        live.entry(id.to_owned()).or_default().wake.clone()
    }

    fn set_tools(&self, id: &str, tools: Vec<McpTool>) {
        let mut live = self.live.write().unwrap_or_else(|p| p.into_inner());
        let session = live.entry(id.to_owned()).or_default();
        session.tools = tools;
        session.problem = None;
    }

    fn set_problem(&self, id: &str, why: String) {
        let mut live = self.live.write().unwrap_or_else(|p| p.into_inner());
        live.entry(id.to_owned()).or_default().problem = Some(why);
    }

    fn drop_client(&self, id: &str) {
        let mut live = self.live.write().unwrap_or_else(|p| p.into_inner());
        if let Some(session) = live.get_mut(id)
            && session.client.take().is_some()
        {
            session.generation += 1;
        }
    }
}
