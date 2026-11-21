//! Connectors (ADR 0131): Spade's bots use the person's apps through the apps' own remote MCP
//! servers. [`Connectors`] keeps the person's connected servers, signs in to them (OAuth under
//! the MCP authorization spec, or a token), keeps a live session and tool list for each, says
//! which bots may use which, and runs calls.
//!
//! Secrets (access and refresh tokens, client secrets, API keys) are only ever in the OS
//! keychain; the database holds the rest. No view, error or log line carries a secret.

pub mod apps;
pub mod catalogue;
pub mod cloud;
mod cloud_sign_in;
mod device_sign_in;
pub mod failure;
pub mod fit;
mod hub;
mod live;
pub mod oauth;
pub mod records;
mod secrets;
pub mod setups;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::Serialize;
use spade_keys::KeyStore;
use spade_mcp::{McpClient, McpTool};
use spade_store::Store;
use tokio::sync::Notify;

pub use apps::{App, Grant};
pub use catalogue::{Category, Entry, Listed, Ready, SignIn, Via, WaitsFor};
pub use cloud::{AccountCredential, AccountProblem, CLOUD_URL, Cloud, Credential};
pub use device_sign_in::DeviceView;
pub use hub::{Callback, ConnectError, ConnectRequest, FinishError, Started};
pub use live::{CallError, ConnectorTool, RELIST, SEPARATOR};
pub use oauth::Addresses;
pub use oauth::cimd::CLIENT_METADATA_URL;
pub use oauth::pkce::{OsRandom, Random};
pub use records::Access;
use records::Record;
pub use setups::{AppSetup, Setups};

/// The path of Spade's sign-in callbacks, under its own address. A client Spade registered, or
/// one the person gave, comes back to its connector's own, `<CALLBACK_PATH>/<connector id>`, so
/// an answer meant for one authorization server can't finish another's sign-in, even from a
/// server that doesn't name itself (RFC 9207). A sign-in as Spade's client ID metadata document
/// comes back to `CALLBACK_PATH` itself, the one address the document lists, and must carry `iss`
/// ([`oauth::cimd`]).
pub const CALLBACK_PATH: &str = "/v1/connectors/callback";

/// How long Spade trusts Spade Cloud's list of the apps it can sign in to, and how long it waits
/// before asking again after the cloud didn't answer.
pub const CLOUD_APPS_FOR_MS: i64 = 10 * 60 * 1000;
pub const CLOUD_APPS_RETRY_MS: i64 = 60 * 1000;
/// How long the app's list of apps waits for the cloud's answer.
const CLOUD_APPS_WAIT: Duration = Duration::from_secs(3);

/// How often a connector's last use is written: a busy app is written at most once a minute.
pub const USED_EVERY_MS: i64 = 60 * 1000;

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
    /// How often each server's tool list is read again unasked ([`RELIST`] in Spade).
    pub relist: Duration,
    /// How names resolve and which networks are this machine's ([`Addresses::system`] in Spade).
    pub addresses: oauth::Addresses,
    /// The client ID metadata document Spade signs in as where a server fetches them
    /// ([`CLIENT_METADATA_URL`] in Spade). `None`: always register, or ask for a client ID.
    pub client_metadata: Option<String>,
    /// Spade's own registered apps, public client IDs only ([`apps::shipped`] in Spade).
    pub apps: Vec<App>,
    /// How long one second of a device sign-in's polling interval lasts: a second in Spade;
    /// tests shorten it so RFC 8628's five-second steps don't slow them.
    pub tick: Duration,
    /// Spade Cloud, for catalogue entries marked `via: "cloud"` (ADR 0140). `None`: those entries
    /// take the person's own client ID only.
    pub cloud: Option<Cloud>,
    /// Setup steps for apps that take the person's own client ID ([`setups::shipped`] in Spade).
    pub setups: Setups,
}

/// What Spade Cloud last said about the apps it can sign in to.
#[derive(Default)]
struct CloudApps {
    /// None until the cloud first answers.
    apps: Option<std::collections::HashSet<String>>,
    asked_ms: Option<i64>,
}

/// What the app is shown about one connector. Never a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct View {
    pub id: String,
    pub name: String,
    pub url: String,
    pub catalogue: Option<String>,
    /// The person marked it as a server on their own machine or network.
    pub local: bool,
    /// `oauth`, `token` or `none`.
    pub sign_in: &'static str,
    /// `connected`, `connecting`, `unreachable`, `needs_reconnect` or `signing_in`.
    pub state: &'static str,
    pub account: Option<String>,
    pub tools: usize,
    /// Why it is unreachable, in a few words.
    pub problem: Option<String>,
    /// A device sign-in (RFC 8628) in progress or just ended: the code to show and where.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<DeviceView>,
    /// `cloud` when it signs in through Spade Cloud.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<&'static str>,
    /// Why a connector signed in through Spade Cloud can't renew now: `cloud_unreachable`,
    /// `ace_signed_out` or `ace_unreachable`. It keeps working until its token expires.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<&'static str>,
    /// When a bot last ran one of its tools, in ms since the epoch (to the minute).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_ms: Option<i64>,
    /// Why its last browser sign-in failed, lately ([`failure::reason`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed: Option<&'static str>,
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
    /// Where sign-in traffic may go (see [`oauth::net`]).
    addresses: oauth::Addresses,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    random: Arc<dyn Random>,
    catalogue: Vec<Entry>,
    timeout: Duration,
    relist: Duration,
    client_metadata: Option<String>,
    apps: Vec<App>,
    setups: Setups,
    tick: Duration,
    /// Spade Cloud's client, when Spade signs in through it.
    cloud: Option<cloud::CloudClient>,
    /// The apps Spade Cloud last said it can sign in to, and when Spade last asked.
    cloud_apps: tokio::sync::Mutex<CloudApps>,
    /// Sign-ins through the cloud waiting for the person, by connector.
    cloud_sign_ins: Mutex<HashMap<String, cloud_sign_in::CloudSignIn>>,
    cloud_serial: std::sync::atomic::AtomicU64,
    /// Why a connector signed in through the cloud last failed to renew, and when.
    cloud_notices: Mutex<HashMap<String, (cloud_sign_in::Notice, i64)>>,
    /// Why browser sign-ins failed lately, by connector.
    failures: Mutex<HashMap<String, failure::Failure>>,
    /// Device sign-ins in progress or recently ended, by connector.
    devices: Mutex<HashMap<String, device_sign_in::DeviceSignIn>>,
    /// Numbers each device sign-in, so a replaced one's poller can't touch its successor.
    device_serial: std::sync::atomic::AtomicU64,
    /// Where callbacks come back to, without the connector's id.
    redirect: RwLock<Option<String>>,
    /// The connectors, as stored. Changed under this lock, then written.
    records: Mutex<Vec<Record>>,
    access: Mutex<BTreeMap<String, Access>>,
    /// Sign-ins in progress, by `state`.
    pending: Mutex<HashMap<String, hub::Pending>>,
    live: RwLock<HashMap<String, Live>>,
    keepers: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    renewing: tokio::sync::Mutex<()>,
    /// Held while a connector's credentials or record are written, by sign-in, renewal and
    /// disconnect alike, so a write never lands after a disconnect.
    writes: tokio::sync::Mutex<()>,
    /// Each connector's credential epoch: changed by every disconnect, so a sign-in or renewal
    /// that began before it drops its result instead of writing.
    epochs: Mutex<HashMap<String, u64>>,
}

impl Connectors {
    /// Reads the stored connectors. Nothing is sent and no keychain is read until
    /// [`Connectors::start`].
    pub fn open(setup: Setup) -> Result<Arc<Self>, String> {
        let records = records::load(&setup.store)?;
        let access = records::load_access(&setup.store)?;
        Ok(Arc::new(Self {
            store: setup.store,
            keys: setup.keys,
            addresses: setup.addresses,
            clock: setup.clock,
            random: setup.random,
            catalogue: catalogue::with_cloud(
                catalogue::with_apps(setup.catalogue, &setup.apps),
                setup.cloud.is_some(),
            ),
            cloud: setup
                .cloud
                .as_ref()
                .map(|cloud| cloud::CloudClient::new(cloud, setup.timeout)),
            cloud_apps: tokio::sync::Mutex::default(),
            cloud_sign_ins: Mutex::default(),
            cloud_serial: std::sync::atomic::AtomicU64::new(0),
            cloud_notices: Mutex::default(),
            timeout: setup.timeout,
            relist: setup.relist,
            client_metadata: setup.client_metadata,
            apps: setup.apps,
            setups: setup.setups,
            tick: setup.tick,
            failures: Mutex::default(),
            devices: Mutex::default(),
            device_serial: std::sync::atomic::AtomicU64::new(0),
            redirect: RwLock::new(None),
            records: Mutex::new(records),
            access: Mutex::new(access),
            pending: Mutex::default(),
            live: RwLock::default(),
            keepers: Mutex::default(),
            renewing: tokio::sync::Mutex::new(()),
            writes: tokio::sync::Mutex::new(()),
            epochs: Mutex::default(),
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
        let base = format!("http://{host}:{}{CALLBACK_PATH}", address.port());
        *self.redirect.write().unwrap_or_else(|p| p.into_inner()) = Some(base);
    }

    /// The callback a sign-in to `connector` with a client the person made comes back to, once
    /// Spade listens: what the person pastes at the maker.
    pub fn callback(&self, connector: &str) -> Option<String> {
        let base = self.redirect.read().unwrap_or_else(|p| p.into_inner());
        base.as_ref().map(|base| format!("{base}/{connector}"))
    }

    /// The setup steps for catalogue entry `connector`, if it ships them (ADR 0197).
    pub fn setup(&self, connector: &str) -> Option<&AppSetup> {
        self.setups.get(connector)
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

    /// The catalogue as the app is shown it, each entry with whether it can be connected now.
    /// Asks Spade Cloud which apps it holds a client for, at most every [`CLOUD_APPS_FOR_MS`]
    /// (every [`CLOUD_APPS_RETRY_MS`] while it doesn't answer); until it first answers, apps
    /// through the cloud are not ready.
    pub async fn listed(&self) -> Vec<Listed<'_>> {
        let Some(cloud) = &self.cloud else {
            return catalogue::listed(&self.catalogue, None);
        };
        let mut known = self.cloud_apps.lock().await;
        let now = self.now();
        let due = match (&known.apps, known.asked_ms) {
            (_, None) => true,
            (Some(_), Some(at)) => now - at >= CLOUD_APPS_FOR_MS,
            (None, Some(at)) => now - at >= CLOUD_APPS_RETRY_MS,
        };
        if due {
            known.asked_ms = Some(now);
            if let Ok(apps) = cloud.apps(CLOUD_APPS_WAIT).await {
                known.apps = Some(apps);
            }
        }
        catalogue::listed(&self.catalogue, known.apps.as_ref())
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
                    local: pending.local,
                    sign_in: "oauth",
                    state: "signing_in",
                    account: None,
                    tools: 0,
                    problem: None,
                    device: None,
                    via: None,
                    notice: None,
                    last_used_ms: None,
                    failed: None,
                });
            }
        }
        views.extend(self.device_views_without_records(&views));
        let cloud = self.cloud_views_without_records(&views);
        views.extend(cloud);
        views.sort_by_key(|view| view.name.to_lowercase());
        views
    }

    /// One connector, if it exists or is signing in.
    /// A first sign-in that failed lately is found here too, never in the list, so the app that
    /// started it can say why without a row for an app that never connected.
    pub fn get(&self, id: &str) -> Option<View> {
        let views = self.list();
        if let Some(view) = views.iter().find(|v| v.id == id) {
            return Some(view.clone());
        }
        self.failed_views_without_records(&views)
            .into_iter()
            .find(|v| v.id == id)
    }

    fn view(&self, record: &Record) -> View {
        let live = self.live.read().unwrap_or_else(|p| p.into_inner());
        let live = live.get(&record.id);
        let device = self.device_view(&record.id);
        let signing_in = lock(&self.pending).values().any(|p| p.id == record.id)
            || device.as_ref().is_some_and(DeviceView::waiting)
            || self.cloud_signing_in(&record.id);
        let cloud = matches!(&record.auth, records::Auth::Oauth(facts) if facts.cloud);
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
            local: record.local,
            sign_in: match record.auth {
                records::Auth::None => "none",
                records::Auth::Token => "token",
                records::Auth::Oauth(_) => "oauth",
            },
            state,
            account: record.account.clone(),
            tools,
            problem,
            device,
            via: cloud.then_some("cloud"),
            notice: if cloud {
                self.cloud_notice(&record.id)
            } else {
                None
            },
            last_used_ms: record.last_used_ms,
            failed: self.failure(&record.id),
        }
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn record(&self, id: &str) -> Option<Record> {
        lock(&self.records).iter().find(|r| r.id == id).cloned()
    }

    fn epoch(&self, id: &str) -> u64 {
        lock(&self.epochs).get(id).copied().unwrap_or(0)
    }

    /// Ends every credential write begun under the current epoch of `id`.
    fn next_epoch(&self, id: &str) {
        *lock(&self.epochs).entry(id.to_owned()).or_default() += 1;
    }

    /// Replaces `record` if it still exists, then writes every record. Returns whether it did:
    /// a connector disconnected meanwhile stays gone.
    fn update_record(&self, record: Record) -> Result<bool, String> {
        let mut records = lock(&self.records);
        let mut next = records.clone();
        let Some(existing) = next.iter_mut().find(|r| r.id == record.id) else {
            return Ok(false);
        };
        *existing = record;
        records::save(&self.store, &next)?;
        *records = next;
        Ok(true)
    }

    /// Notes that a bot used `id` now, writing it at most every [`USED_EVERY_MS`].
    pub(crate) fn touch(&self, id: &str) {
        let now = self.now();
        let mut records = lock(&self.records);
        let stale = records
            .iter()
            .find(|r| r.id == id)
            .is_some_and(|r| r.last_used_ms.is_none_or(|at| now - at >= USED_EVERY_MS));
        if !stale {
            return;
        }
        let mut next = records.clone();
        if let Some(record) = next.iter_mut().find(|r| r.id == id) {
            record.last_used_ms = Some(now);
        }
        match records::save(&self.store, &next) {
            Ok(()) => *records = next,
            Err(error) => tracing::warn!(%error, "a connector's last use was not written"),
        }
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
