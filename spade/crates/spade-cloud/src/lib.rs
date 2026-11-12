//! Spade Cloud (ADR 0139, `spade/docs/cloud.md`): Spade's hosted backend at `cloud.acehq.dev`.
//! Its first job is the OAuth broker for apps whose sign-in needs a client secret (Asana, Box,
//! Canva, HubSpot): Spade starts a sign-in with a PKCE challenge and a one-time key, the maker
//! redirects back here, Spade finishes with its verifier, and the cloud exchanges the code with
//! its secret and returns the tokens sealed to Spade's key. Requests carry the person's ace
//! account grant. Nothing is stored but sign-ins in progress and rate-limit counters, in memory;
//! no token is kept or logged.

pub mod apps;
pub mod config;
pub mod grant;
pub mod keys;
pub mod limits;
pub mod maker;
mod page;
mod routes;
pub mod sign_ins;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::HeaderName;
use ring::rand::SecureRandom;

pub use routes::router;

/// Milliseconds since the epoch.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// What the service is made from. Everything it can't control is passed in.
pub struct Setup {
    pub apps: Vec<apps::Configured>,
    /// The service's own address, such as `https://cloud.acehq.dev`; makers redirect to its
    /// callback path.
    pub public_url: String,
    pub keys: Arc<dyn keys::KeySource>,
    pub clock: Clock,
    pub random: Arc<dyn SecureRandom + Send + Sync>,
    /// The header the hosting proxy puts the client's address in (its last value is used); the
    /// peer address when `None`.
    pub address_header: Option<HeaderName>,
    pub maker_timeout: Duration,
    pub account_budget: limits::Budget,
    pub address_budget: limits::Budget,
}

impl Setup {
    /// Per account: a burst of 60, then one a second (Spade polls a sign-in every 3 s). Per
    /// address: a burst of 120, then two a second.
    pub const ACCOUNT_BUDGET: limits::Budget = limits::Budget {
        burst: 60,
        every_ms: 1_000,
    };
    pub const ADDRESS_BUDGET: limits::Budget = limits::Budget {
        burst: 120,
        every_ms: 500,
    };
}

pub struct Service {
    apps: Vec<apps::Configured>,
    redirect: String,
    keys: keys::GrantKeys,
    clock: Clock,
    random: Arc<dyn SecureRandom + Send + Sync>,
    address_header: Option<HeaderName>,
    maker: maker::Maker,
    sign_ins: Mutex<sign_ins::SignIns>,
    accounts: Mutex<limits::Limits>,
    addresses: Mutex<limits::Limits>,
}

impl Service {
    pub fn new(setup: Setup) -> Arc<Self> {
        Arc::new(Self {
            apps: setup.apps,
            redirect: format!(
                "{}{}",
                setup.public_url.trim_end_matches('/'),
                spade_cloud_wire::CALLBACK_PATH
            ),
            keys: keys::GrantKeys::new(setup.keys, setup.clock.clone()),
            clock: setup.clock,
            random: setup.random,
            address_header: setup.address_header,
            maker: maker::Maker::new(setup.maker_timeout),
            sign_ins: Mutex::default(),
            accounts: Mutex::new(limits::Limits::new(setup.account_budget)),
            addresses: Mutex::new(limits::Limits::new(setup.address_budget)),
        })
    }

    /// How many sign-ins are held in memory now.
    pub fn sign_ins_held(&self) -> usize {
        lock(&self.sign_ins).len()
    }

    fn now(&self) -> u64 {
        u64::try_from((self.clock)()).unwrap_or(0)
    }
}

/// Serves `service` on `listener` until `shutdown` resolves, then lets requests in flight end.
pub async fn serve(
    listener: tokio::net::TcpListener,
    service: Arc<Service>,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(
        listener,
        router(service).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
}

/// The current time in ms since the epoch.
pub fn system_clock() -> Clock {
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
