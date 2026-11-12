//! The account backend's published grant keys, fetched and kept. A grant naming a key id the set
//! doesn't hold fetches the set again, at most once a minute, so a rotated key is picked up and
//! a flood of made-up ids can't hammer the backend.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use crate::Clock;
use crate::grant::{self, Claims, GrantError, KeySet, Kind};

/// How long a fetched set is used before it is fetched again.
const KEEP_MS: u64 = 60 * 60_000;
/// The least time between two fetches.
const REFETCH_MS: u64 = 60_000;

pub type Fetched<'a> = Pin<Box<dyn Future<Output = Result<KeySet, String>> + Send + 'a>>;

/// Where the key set comes from: the account backend's `GET /v1/keys`, or fixed keys in tests.
pub trait KeySource: Send + Sync {
    fn fetch(&self) -> Fetched<'_>;
}

/// `<origin>/v1/keys` over https.
pub struct HttpKeys {
    url: String,
    http: reqwest::Client,
}

impl HttpKeys {
    pub fn new(origin: &str) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            url: format!("{}/v1/keys", origin.trim_end_matches('/')),
            http,
        }
    }
}

impl KeySource for HttpKeys {
    fn fetch(&self) -> Fetched<'_> {
        Box::pin(async move {
            let response = self
                .http
                .get(&self.url)
                .send()
                .await
                .map_err(|_| "the account backend didn't answer".to_owned())?;
            if !response.status().is_success() {
                return Err(format!(
                    "the account backend answered {}",
                    response.status().as_u16()
                ));
            }
            let set: KeySet = response
                .json()
                .await
                .map_err(|_| "the account backend's keys didn't read".to_owned())?;
            set.checked()
        })
    }
}

struct Cached {
    set: Option<KeySet>,
    fetched_ms: u64,
}

pub struct GrantKeys {
    source: Arc<dyn KeySource>,
    clock: Clock,
    cached: tokio::sync::Mutex<Cached>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CheckError {
    #[error("{0}")]
    Grant(#[from] GrantError),
    /// No keys to check with: the account backend is away.
    #[error("{0}")]
    NoKeys(String),
}

impl GrantKeys {
    pub fn new(source: Arc<dyn KeySource>, clock: Clock) -> Self {
        Self {
            source,
            clock,
            cached: tokio::sync::Mutex::new(Cached {
                set: None,
                fetched_ms: 0,
            }),
        }
    }

    /// Verifies a `machine` grant: the credential Spade sends for the machine it runs on.
    pub async fn machine(&self, token: &str) -> Result<Claims, CheckError> {
        let now = self.now();
        let mut cached = self.cached.lock().await;
        let stale = cached.set.is_none() || now.saturating_sub(cached.fetched_ms) >= KEEP_MS;
        if stale {
            self.refetch(&mut cached, now).await?;
        }
        let set = cached
            .set
            .clone()
            .ok_or_else(|| CheckError::NoKeys("no keys".into()))?;
        match grant::verify_cloud(token, &set, now, &Kind::Machine) {
            Err(GrantError::UnknownKey(kid))
                if !stale && now.saturating_sub(cached.fetched_ms) >= REFETCH_MS =>
            {
                self.refetch(&mut cached, now).await?;
                let set = cached
                    .set
                    .clone()
                    .ok_or_else(|| CheckError::NoKeys("no keys".into()))?;
                Ok(
                    grant::verify_cloud(token, &set, now, &Kind::Machine).map_err(|e| match e {
                        GrantError::UnknownKey(_) => GrantError::UnknownKey(kid),
                        other => other,
                    })?,
                )
            }
            other => Ok(other?),
        }
    }

    async fn refetch(&self, cached: &mut Cached, now: u64) -> Result<(), CheckError> {
        match self.source.fetch().await {
            Ok(set) => {
                cached.set = Some(set);
                cached.fetched_ms = now;
                Ok(())
            }
            // Keep using the old set while the backend is away; refuse only with none at all.
            Err(why) if cached.set.is_none() => Err(CheckError::NoKeys(why)),
            Err(why) => {
                tracing::warn!(reason = %why, "the account backend's keys could not be fetched again");
                cached.fetched_ms = now;
                Ok(())
            }
        }
    }

    fn now(&self) -> u64 {
        u64::try_from((self.clock)()).unwrap_or(0)
    }
}
