//! The signed-in accounts' tokens: in the OS keychain (`oauth:<account>:access` and `:refresh`,
//! ADR 0214), held in memory while in use, refreshed when the access token nears its end. One
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

/// One account's tokens in memory, behind the lock every read, refresh, keep and forget of that
/// account takes.
type Slot = Arc<tokio::sync::Mutex<Option<Held>>>;

/// What the work on one account needs, cloned so it can run in its own task: work that writes the
/// keychain always finishes under the account's lock, even when its caller stops waiting, so a
/// forget that follows it can't be undone by it.
#[derive(Clone)]
struct Parts {
    keys: Option<KeyStore>,
    http: reqwest::Client,
    config: Config,
    clock: Clock,
    /// Each account's generation: changed whenever its credential stops being the one a call
    /// may hold (a sign-in, a sign-out, a removal, a refused refresh). A call holds the token
    /// with its generation and is sent only while that generation is current.
    generations: Arc<Mutex<HashMap<String, u64>>>,
    /// The last refresh that failed for each account: its generation, the token it was to
    /// replace and why, shared with every call that reports the same token.
    failed: Arc<Mutex<HashMap<String, FailedRefresh>>>,
}

/// A refresh that failed: the generation and token it was for, and why.
type FailedRefresh = (u64, String, String);

/// An access token with the generation of the credential it belongs to.
#[derive(Clone, PartialEq, Eq)]
pub struct Bearer {
    pub token: String,
    pub generation: u64,
}

impl std::fmt::Debug for Bearer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Bearer(…, generation {})", self.generation)
    }
}

/// Said when a call's credential changed under it.
const CHANGED: &str = "This ChatGPT account was signed out or signed in again while the call \
                       was under way; send it again.";

/// The tokens of every signed-in account.
pub struct Accounts {
    parts: Parts,
    held: Mutex<HashMap<String, Slot>>,
}

impl Accounts {
    pub fn new(keys: Option<KeyStore>, config: Config, clock: Clock) -> Result<Self, String> {
        Ok(Self {
            parts: Parts {
                keys,
                http: oauth::client()?,
                config,
                clock,
                generations: Arc::default(),
                failed: Arc::default(),
            },
            held: Mutex::default(),
        })
    }

    pub fn config(&self) -> &Config {
        &self.parts.config
    }

    pub(crate) fn http(&self) -> &reqwest::Client {
        &self.parts.http
    }

    /// The clock tokens are checked against.
    pub(crate) fn clock(&self) -> Clock {
        self.parts.clock.clone()
    }

    /// Whether this machine has a keychain to keep sign-ins in.
    pub fn can_keep(&self) -> bool {
        self.parts.keys.is_some()
    }

    fn slot(&self, account: &str) -> Slot {
        self.held
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(account.to_owned())
            .or_default()
            .clone()
    }

    /// Runs `op` on `account`'s tokens in its own task, holding the account's lock to the end.
    async fn locked(&self, account: &str, op: Op) -> Result<Done, BearerError> {
        let (slot, parts, id) = (self.slot(account), self.parts.clone(), account.to_owned());
        tokio::spawn(async move {
            let mut held = slot.lock_owned().await;
            parts.run(&id, &mut held, op).await
        })
        .await
        .map_err(|_| BearerError::Failed("the sign-in work stopped".to_owned()))?
    }

    /// An access token for `account`, refreshed first when it is about to end.
    pub async fn bearer(&self, account: &str) -> Result<String, BearerError> {
        self.current_bearer(account).await.map(|b| b.token)
    }

    /// [`Accounts::bearer`] with the generation of its credential, for a call that must check,
    /// before each send, that the credential is still the account's ([`Accounts::is_current`]).
    pub async fn current_bearer(&self, account: &str) -> Result<Bearer, BearerError> {
        match self.locked(account, Op::Bearer(None)).await? {
            Done::Token(bearer) => Ok(bearer),
            Done::Forgot(_) | Done::Kept => Err(BearerError::Failed("no token".to_owned())),
        }
    }

    /// A new access token for `account` after the backend refused `rejected`, a token of
    /// `generation`: refreshed now, unless another call already replaced it (that one is given)
    /// or a refresh for it already failed (that failure is given). Refused when the credential
    /// changed since: a call never moves to another sign-in.
    pub async fn bearer_after_rejection(
        &self,
        account: &str,
        rejected: &str,
        generation: u64,
    ) -> Result<Bearer, BearerError> {
        match self
            .locked(
                account,
                Op::Rejected {
                    token: rejected.to_owned(),
                    generation,
                },
            )
            .await?
        {
            Done::Token(bearer) => Ok(bearer),
            Done::Forgot(_) | Done::Kept => Err(BearerError::Failed("no token".to_owned())),
        }
    }

    /// Whether `generation` is still `account`'s credential: no sign-in, sign-out, removal or
    /// refused refresh since.
    pub fn is_current(&self, account: &str, generation: u64) -> bool {
        self.parts.generation(account) == generation
    }

    /// Keeps a sign-in's tokens for `account`, replacing any earlier ones.
    pub async fn keep(&self, account: &str, tokens: &Tokens) -> Result<(), BearerError> {
        self.locked(account, Op::Keep(tokens.clone()))
            .await
            .map(|_| ())
    }

    /// Signs `account` out: its tokens leave memory and the keychain, after any refresh or keep
    /// of it under way. Returns whether it had any.
    pub async fn forget(&self, account: &str) -> Result<bool, BearerError> {
        match self.locked(account, Op::Forget).await? {
            Done::Forgot(had) => Ok(had),
            Done::Token(_) | Done::Kept => Ok(false),
        }
    }

    /// [`Accounts::forget`] for blocking code (never on an async worker): waits for the account's
    /// lock, so nothing under way writes the tokens back after.
    pub fn forget_now(&self, account: &str) -> Result<bool, BearerError> {
        let slot = self.slot(account);
        let mut held = slot.blocking_lock();
        *held = None;
        self.parts.bump(account);
        match &self.parts.keys {
            Some(keys) => keys
                .delete_sign_in(account)
                .map_err(|e| BearerError::Failed(e.to_string())),
            None => Ok(false),
        }
    }
}

/// What is done to one account's tokens under its lock.
enum Op {
    /// Its access token; refreshed when near its end.
    Bearer(Option<String>),
    /// A new one after the backend refused `token`, of `generation`.
    Rejected {
        token: String,
        generation: u64,
    },
    Keep(Tokens),
    Forget,
}

enum Done {
    Token(Bearer),
    Kept,
    Forgot(bool),
}

impl Parts {
    fn generation(&self, account: &str) -> u64 {
        self.generations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(account)
            .copied()
            .unwrap_or(0)
    }

    /// A new generation for `account`: every token held under the old one stops being sent.
    fn bump(&self, account: &str) {
        *self
            .generations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(account.to_owned())
            .or_insert(0) += 1;
        self.failed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(account);
    }

    async fn run(&self, id: &str, held: &mut Option<Held>, op: Op) -> Result<Done, BearerError> {
        match op {
            Op::Bearer(rejected) => {
                let token = self.bearer(id, held, rejected.as_deref()).await?;
                Ok(Done::Token(Bearer {
                    token,
                    generation: self.generation(id),
                }))
            }
            Op::Rejected { token, generation } => {
                if self.generation(id) != generation {
                    return Err(BearerError::Failed(CHANGED.to_owned()));
                }
                let shared = self
                    .failed
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(id)
                    .filter(|(g, t, _)| *g == generation && *t == token)
                    .map(|(_, _, line)| line.clone());
                if let Some(line) = shared {
                    return Err(BearerError::Failed(line));
                }
                match self.bearer(id, held, Some(&token)).await {
                    Ok(fresh) => Ok(Done::Token(Bearer {
                        token: fresh,
                        generation: self.generation(id),
                    })),
                    Err(BearerError::Failed(line)) => {
                        self.failed
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .insert(id.to_owned(), (generation, token, line.clone()));
                        Err(BearerError::Failed(line))
                    }
                    Err(other) => Err(other),
                }
            }
            Op::Keep(tokens) => {
                self.write(id, &tokens.access_token, &tokens.refresh_token)
                    .await?;
                *held = Some(Held {
                    expires: crate::claims::expires(&tokens.access_token),
                    access: tokens.access_token,
                    refresh: tokens.refresh_token,
                });
                self.bump(id);
                Ok(Done::Kept)
            }
            Op::Forget => {
                *held = None;
                self.bump(id);
                self.erase(id).await.map(Done::Forgot)
            }
        }
    }

    /// The account's access token: refreshed when it nears its end, or when it is `rejected`.
    async fn bearer(
        &self,
        account: &str,
        held: &mut Option<Held>,
        rejected: Option<&str>,
    ) -> Result<String, BearerError> {
        if held.is_none() {
            *held = self.load(account).await?;
        }
        let Some(current) = held.clone() else {
            return Err(BearerError::SignedOut(SIGNED_OUT.to_owned()));
        };
        let fresh = current
            .expires
            .is_none_or(|at| at - (self.clock)() > REFRESH_EARLY_S);
        let refused = rejected.is_some_and(|r| r == current.access);
        if fresh && !refused {
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
                self.bump(account);
                self.erase(account).await?;
                Err(BearerError::SignedOut(line))
            }
            Err(OauthError::Failed(line)) => Err(BearerError::Failed(line)),
        }
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
