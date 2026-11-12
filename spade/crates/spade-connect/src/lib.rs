//! Connectors (ADR 0131): Spade's bots use the person's apps through the apps' own remote MCP
//! servers. [`Connectors`] keeps the person's connected servers, signs in to them (OAuth under
//! the MCP authorization spec, or a token), keeps a live session and tool list for each, says
//! which bots may use which, and runs calls.
//!
//! Secrets (access and refresh tokens, client secrets, API keys) are only ever in the OS
//! keychain; the database holds the rest. No view, error or log line carries a secret.

pub mod catalogue;
mod hub;
mod live;
pub mod oauth;
pub mod records;
mod secrets;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::Serialize;
use spade_keys::KeyStore;
use spade_mcp::{McpClient, McpTool};
use spade_store::Store;
use tokio::sync::Notify;

pub use catalogue::{Entry, SignIn};
pub use hub::{Callback, ConnectError, ConnectRequest, FinishError, Started};
pub use live::{CallError, ConnectorTool};
pub use oauth::pkce::{OsRandom, Random};
pub use records::Access;
use records::Record;

/// The path of Spade's sign-in callback, under its own address.
pub const CALLBACK_PATH: &str = "/v1/connectors/callback";

/// How long a sign-in may take from start to callback.
pub const SIGN_IN_WINDOW_MS: i64 = 10 * 60 * 1000;

/// What a connector needs from Spade.
pub struct Setup {
    pub store: Store,
    /// The OS keychain. Without one, only servers that need no credential can be connected.
    pub keys: Option<KeyStore>,
    /// Milliseconds since the epoch.
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub random: Arc<dyn Random>,
    pub catalogue: Vec<Entry>,
    /// Each sign-in request and each tool call gives up after this.
    pub timeout: Duration,
}

/// What the app is shown about one connector. Never a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct View {
    pub id: String,
    pub name: String,
    pub url: String,
    pub catalogue: Option<String>,
    /// `oauth`, `token` or `none`.
    pub sign_in: &'static str,
    /// `connected`, `connecting`, `unreachable`, `needs_reconnect` or `signing_in`.
    pub state: &'static str,
    pub account: Option<String>,
    pub tools: usize,
    /// Why it is unreachable, in a few words.
    pub problem: Option<String>,
}

/// One connector's live session.
#[derive(Default)]
struct Live {
    client: Option<Arc<McpClient>>,
    /// The tools last listed; kept while the server is away or the sign-in expired, so a call
    /// can say why it did not run.
    tools: Vec<McpTool>,
    /// Changes whenever the client is replaced, so a renewal is done once.
    generation: u64,
    problem: Option<String>,
    /// Rung when the client changes, so the session keeper follows it.
    wake: Arc<Notify>,
}

pub struct Connectors {
    store: Store,
    keys: Option<KeyStore>,
    http: reqwest::Client,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    random: Arc<dyn Random>,
    catalogue: Vec<Entry>,
    timeout: Duration,
    redirect: RwLock<Option<String>>,
    /// The connectors, as stored. Changed under this lock, then written.
    records: Mutex<Vec<Record>>,
    access: Mutex<BTreeMap<String, Access>>,
    /// Sign-ins in progress, by `state`.
    pending: Mutex<HashMap<String, hub::Pending>>,
    live: RwLock<HashMap<String, Live>>,
    keepers: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    renewing: tokio::sync::Mutex<()>,
}

impl Connectors {
    /// Reads the stored connectors. Nothing is sent and no keychain is read until
    /// [`Connectors::start`].
    pub fn open(setup: Setup) -> Result<Arc<Self>, String> {
        let http = oauth::http_client(setup.timeout)?;
        let records = records::load(&setup.store)?;
        let access = records::load_access(&setup.store)?;
        Ok(Arc::new(Self {
            store: setup.store,
            keys: setup.keys,
            http,
            clock: setup.clock,
            random: setup.random,
            catalogue: setup.catalogue,
            timeout: setup.timeout,
            redirect: RwLock::new(None),
            records: Mutex::new(records),
            access: Mutex::new(access),
            pending: Mutex::default(),
            live: RwLock::default(),
            keepers: Mutex::default(),
            renewing: tokio::sync::Mutex::new(()),
        }))
    }

    /// Sets where sign-ins come back to: Spade's own address, once it is listening.
    pub fn set_listening(&self, address: std::net::SocketAddr) {
        let host = if address.ip().is_unspecified() {
            "127.0.0.1".to_owned()
        } else {
            match address.ip() {
                std::net::IpAddr::V6(ip) => format!("[{ip}]"),
                std::net::IpAddr::V4(ip) => ip.to_string(),
            }
        };
        let redirect = format!("http://{host}:{}{CALLBACK_PATH}", address.port());
        *self.redirect.write().unwrap_or_else(|p| p.into_inner()) = Some(redirect);
    }

    /// Opens a session to every stored connector, in the background.
    pub fn start(self: &Arc<Self>) {
        let ids: Vec<String> = lock(&self.records).iter().map(|r| r.id.clone()).collect();
        for id in ids {
            self.keep(&id);
        }
    }

    pub fn catalogue(&self) -> &[Entry] {
        &self.catalogue
    }

    /// Every connector, connected or signing in, by name.
    pub fn list(&self) -> Vec<View> {
        let records = lock(&self.records).clone();
        let mut views: Vec<View> = records.iter().map(|r| self.view(r)).collect();
        let now = self.now();
        for pending in lock(&self.pending).values() {
            if now - pending.started_ms < SIGN_IN_WINDOW_MS
                && !views.iter().any(|v| v.id == pending.id)
            {
                views.push(View {
                    id: pending.id.clone(),
                    name: pending.name.clone(),
                    url: pending.url.clone(),
                    catalogue: pending.catalogue.clone(),
                    sign_in: "oauth",
                    state: "signing_in",
                    account: None,
                    tools: 0,
                    problem: None,
                });
            }
        }
        views.sort_by_key(|view| view.name.to_lowercase());
        views
    }

    /// One connector, if it exists or is signing in.
    pub fn get(&self, id: &str) -> Option<View> {
        self.list().into_iter().find(|v| v.id == id)
    }

    fn view(&self, record: &Record) -> View {
        let live = self.live.read().unwrap_or_else(|p| p.into_inner());
        let live = live.get(&record.id);
        let signing_in = lock(&self.pending).values().any(|p| p.id == record.id);
        let tools = live.map_or(0, |l| l.tools.len());
        let problem = live.and_then(|l| l.problem.clone());
        let state = if record.needs_reconnect {
            if signing_in {
                "signing_in"
            } else {
                "needs_reconnect"
            }
        } else if live.is_some_and(|l| l.client.is_some() && l.problem.is_none()) {
            "connected"
        } else if problem.is_some() {
            "unreachable"
        } else {
            "connecting"
        };
        View {
            id: record.id.clone(),
            name: record.name.clone(),
            url: record.url.clone(),
            catalogue: record.catalogue.clone(),
            sign_in: match record.auth {
                records::Auth::None => "none",
                records::Auth::Token => "token",
                records::Auth::Oauth(_) => "oauth",
            },
            state,
            account: record.account.clone(),
            tools,
            problem,
        }
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn record(&self, id: &str) -> Option<Record> {
        lock(&self.records).iter().find(|r| r.id == id).cloned()
    }

    /// Replaces or adds `record`, then writes every record.
    fn put_record(&self, record: Record) -> Result<(), String> {
        let mut records = lock(&self.records);
        let mut next = records.clone();
        match next.iter_mut().find(|r| r.id == record.id) {
            Some(existing) => *existing = record,
            None => next.push(record),
        }
        records::save(&self.store, &next)?;
        *records = next;
        Ok(())
    }
}

/// The current time in ms since the epoch, for [`Setup::clock`].
pub fn system_clock() -> Arc<dyn Fn() -> i64 + Send + Sync> {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    })
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
