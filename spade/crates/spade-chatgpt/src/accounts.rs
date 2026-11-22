//! The signed-in accounts' tokens: in the OS keychain (`oauth:<account>:access` and `:refresh`,
//! ADR 0213), held in memory while in use, refreshed when the access token nears its end. One
//! refresh per account at a time, so a refresh token is never sent twice.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use spade_keys::KeyStore;

use crate::oauth::{self, OauthError, Tokens};
use crate::{Clock, Config};

/// An access token with under this many seconds left is refreshed first.
pub const REFRESH_EARLY_S: i64 = 5 * 60;

/// Why an account has no token to call with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BearerError {
    /// No tokens, or the server refused the refresh: the person has to sign in again.
    #[error("{0}")]
    SignedOut(String),
    /// The keychain or the network failed; a later call may work.
    #[error("{0}")]
    Failed(String),
}

const SIGNED_OUT: &str =
    "This ChatGPT account is signed out. Sign in again in Settings › Spade › Models.";

#[derive(Clone)]
struct Held {
    access: String,
    refresh: String,
    expires: Option<i64>,
}

/// The tokens of every signed-in account.
pub struct Accounts {
    keys: Option<KeyStore>,
    http: reqwest::Client,
    config: Config,
    clock: Clock,
    held: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Option<Held>>>>>,
}

impl Accounts {
    pub fn new(keys: Option<KeyStore>, config: Config, clock: Clock) -> Result<Self, String> {
        Ok(Self {
            keys,
            http: oauth::client()?,
            config,
            clock,
            held: Mutex::default(),
        })
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub(crate) fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// Whether this machine has a keychain to keep sign-ins in.
    pub fn can_keep(&self) -> bool {
        self.keys.is_some()
    }

    fn slot(&self, account: &str) -> Arc<tokio::sync::Mutex<Option<Held>>> {
        self.held
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(account.to_owned())
            .or_default()
            .clone()
    }

    /// An access token for `account`, refreshed first when it is about to end.
    pub async fn bearer(&self, account: &str) -> Result<String, BearerError> {
        let slot = self.slot(account);
        let mut held = slot.lock().await;
        if held.is_none() {
            *held = self.load(account).await?;
        }
        let Some(current) = held.clone() else {
            return Err(BearerError::SignedOut(SIGNED_OUT.to_owned()));
        };
        let fresh = current
            .expires
            .is_none_or(|at| at - (self.clock)() > REFRESH_EARLY_S);
        if fresh {
            return Ok(current.access);
        }
        match oauth::refresh(&self.http, &self.config, &current.refresh).await {
            Ok(refreshed) => {
                let next = Held {
                    expires: crate::claims::expires(&refreshed.access_token),
                    access: refreshed.access_token,
                    refresh: refreshed.refresh_token.unwrap_or(current.refresh),
                };
                self.write(account, &next.access, &next.refresh).await?;
                *held = Some(next.clone());
                Ok(next.access)
            }
            Err(OauthError::Refused(line)) => {
                // The tokens are no good: they go, and the person signs in again.
                *held = None;
                self.erase(account).await?;
                Err(BearerError::SignedOut(line))
            }
            Err(OauthError::Failed(line)) => Err(BearerError::Failed(line)),
        }
    }

    /// Keeps a sign-in's tokens for `account`, replacing any earlier ones.
    pub async fn keep(&self, account: &str, tokens: &Tokens) -> Result<(), BearerError> {
        let slot = self.slot(account);
        let mut held = slot.lock().await;
        self.write(account, &tokens.access_token, &tokens.refresh_token)
            .await?;
        *held = Some(Held {
            access: tokens.access_token.clone(),
            refresh: tokens.refresh_token.clone(),
            expires: crate::claims::expires(&tokens.access_token),
        });
        Ok(())
    }

    /// Signs `account` out: its tokens leave the keychain and memory. Returns whether it had any.
    pub async fn forget(&self, account: &str) -> Result<bool, BearerError> {
        let slot = self.slot(account);
        let mut held = slot.lock().await;
        *held = None;
        self.erase(account).await
    }

    async fn load(&self, account: &str) -> Result<Option<Held>, BearerError> {
        let Some(keys) = self.keys.clone() else {
            return Ok(None);
        };
        let id = account.to_owned();
        let read = tokio::task::spawn_blocking(move || {
            let access = keys.sign_in_secret(&id, "access")?;
            let refresh = keys.sign_in_secret(&id, "refresh")?;
            Ok::<_, spade_keys::KeyError>((access, refresh))
        })
        .await
        .map_err(|_| BearerError::Failed("the keychain read stopped".to_owned()))?
        .map_err(|e| BearerError::Failed(e.to_string()))?;
        Ok(match read {
            (Some(access), Some(refresh)) => Some(Held {
                expires: crate::claims::expires(&access),
                access,
                refresh,
            }),
            // A refresh token alone still signs in: its first call refreshes.
            (None, Some(refresh)) => Some(Held {
                access: String::new(),
                refresh,
                expires: Some(i64::MIN),
            }),
            _ => None,
        })
    }

    async fn write(&self, account: &str, access: &str, refresh: &str) -> Result<(), BearerError> {
        let Some(keys) = self.keys.clone() else {
            return Err(BearerError::Failed(
                "this machine has no keychain Spade can keep a sign-in in".to_owned(),
            ));
        };
        let (id, access, refresh) = (account.to_owned(), access.to_owned(), refresh.to_owned());
        tokio::task::spawn_blocking(move || {
            keys.set_sign_in_secret(&id, "refresh", &refresh)?;
            keys.set_sign_in_secret(&id, "access", &access)
        })
        .await
        .map_err(|_| BearerError::Failed("the keychain write stopped".to_owned()))?
        .map_err(|e| BearerError::Failed(e.to_string()))
    }

    async fn erase(&self, account: &str) -> Result<bool, BearerError> {
        let Some(keys) = self.keys.clone() else {
            return Ok(false);
        };
        let id = account.to_owned();
        tokio::task::spawn_blocking(move || keys.delete_sign_in(&id))
            .await
            .map_err(|_| BearerError::Failed("the keychain change stopped".to_owned()))?
            .map_err(|e| BearerError::Failed(e.to_string()))
    }
}
