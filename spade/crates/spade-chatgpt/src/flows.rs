//! Sign-ins in progress: started by the person in Settings, finished by OpenAI's sign-in, read
//! by the app until they end. One runs at a time: starting another cancels a waiting one, which
//! also frees the loopback port.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use serde::Serialize;
use spade_connect::oauth::pkce::{self, Random};

use crate::accounts::Accounts;
use crate::claims::{self, Account};
use crate::loopback;
use crate::oauth::{self, OauthError, Poll, Tokens};

/// How the person signs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    /// A browser on Spade's machine, back to the loopback address.
    Browser,
    /// A code entered on any device.
    Device,
}

impl Method {
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "browser" => Some(Self::Browser),
            "device" => Some(Self::Device),
            _ => None,
        }
    }
}

/// A finished sign-in, handed to whoever keeps the account.
pub struct SignedIn {
    pub tokens: Tokens,
    pub account: Account,
}

/// Keeps a finished sign-in as an account: its id, or one line saying why not.
pub type Finish = Arc<dyn Fn(SignedIn) -> BoxFuture<'static, Result<String, String>> + Send + Sync>;

/// A sign-in as the app reads it. Never a token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FlowView {
    pub id: String,
    pub method: Method,
    /// `waiting`, `done`, `failed` or `cancelled`.
    pub state: &'static str,
    /// Where the person signs in.
    pub url: Option<String>,
    /// For a device sign-in, the code the person enters.
    pub user_code: Option<String>,
    /// Once done, the account it signed in.
    pub endpoint: Option<String>,
    /// Once failed, why, in one line.
    pub error: Option<String>,
}

struct Flow {
    view: FlowView,
    task: Option<tokio::task::AbortHandle>,
    /// Its sign-in is being kept as an account: it can no longer be cancelled.
    committing: bool,
    /// Order started, so the oldest ended ones are dropped first.
    started: u64,
}

/// How many ended sign-ins are remembered for the app to read.
const KEPT: usize = 16;

pub struct Flows {
    accounts: Arc<Accounts>,
    random: Arc<dyn Random>,
    open: Mutex<HashMap<String, Flow>>,
    count: std::sync::atomic::AtomicU64,
    /// Held while a sign-in starts, from cancelling the waiting one to registering the new one,
    /// so two starts never both find nothing waiting.
    starting: tokio::sync::Mutex<()>,
    /// Held while a finished sign-in is kept as an account, so two never pick the same id.
    keeping: tokio::sync::Mutex<()>,
}

impl Flows {
    pub fn new(accounts: Arc<Accounts>, random: Arc<dyn Random>) -> Arc<Self> {
        Arc::new(Self {
            accounts,
            random,
            open: Mutex::default(),
            count: Default::default(),
            starting: tokio::sync::Mutex::default(),
            keeping: tokio::sync::Mutex::default(),
        })
    }

    pub fn accounts(&self) -> &Arc<Accounts> {
        &self.accounts
    }

    /// Held by whoever keeps a finished sign-in as an account, for as long as that takes.
    pub async fn keeping(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.keeping.lock().await
    }

    /// Starts a sign-in. Fails, with one line, when the port is taken, the device code can't be
    /// had, or there is no keychain to keep the result in. Starts one at a time: each cancels the
    /// waiting one before it registers itself.
    pub async fn start(
        self: &Arc<Self>,
        method: Method,
        finish: Finish,
    ) -> Result<FlowView, String> {
        if !self.accounts.can_keep() {
            return Err(
                "this machine has no keychain Spade can keep a sign-in in, so it can't sign in"
                    .to_owned(),
            );
        }
        let _starting = self.starting.lock().await;
        self.cancel_waiting();
        let id = pkce::random_value(self.random.as_ref())?;
        let config = self.accounts.config().clone();
        let http = self.accounts.http().clone();
        let expect = (config.clone(), self.accounts.clock());
        let (view, work): (FlowView, BoxFuture<'static, Result<SignedIn, String>>) = match method {
            Method::Browser => {
                let listener = loopback::bind(config.callback_port).await?;
                let port = listener.local_addr().map_err(|e| e.to_string())?.port();
                let redirect = loopback::redirect(port);
                let verifier = pkce::random_value(self.random.as_ref())?;
                let state = pkce::random_value(self.random.as_ref())?;
                let url =
                    oauth::authorize_url(&config, &redirect, &pkce::challenge(&verifier), &state)?;
                let work = Box::pin(async move {
                    let code = loopback::wait(listener, &state).await?;
                    let tokens = oauth::exchange(&http, &config, &code, &redirect, &verifier)
                        .await
                        .map_err(line)?;
                    signed_in(tokens, &expect)
                });
                (waiting(&id, method, url, None), work)
            }
            Method::Device => {
                let device = oauth::device_code(&http, &config).await.map_err(line)?;
                let view = waiting(
                    &id,
                    method,
                    device.url.clone(),
                    Some(device.user_code.clone()),
                );
                let work = Box::pin(async move {
                    let lasts = device.expires_in;
                    let polling = poll_until_approved(http, config, device, expect);
                    match lasts {
                        // The code ends when the server said, if sooner than the sign-in's wait.
                        Some(lasts) => tokio::time::timeout(lasts, polling)
                            .await
                            .map_err(|_| EXPIRED.to_owned())?,
                        None => polling.await,
                    }
                });
                (view, work)
            }
        };
        let wait = self.accounts.config().wait;
        let flows = Arc::clone(self);
        let flow_id = id.clone();
        let task = tokio::spawn(async move {
            let outcome = match tokio::time::timeout(wait, work).await {
                Err(_) => Err("the sign-in waited too long; start it again".to_owned()),
                Ok(Err(error)) => Err(error),
                // From here it is kept, whatever cancels: a cancel that won already ended it.
                Ok(Ok(done)) if flows.commit(&flow_id) => tokio::spawn(finish(done))
                    .await
                    .unwrap_or_else(|_| Err("keeping the account stopped".to_owned())),
                Ok(Ok(_)) => return,
            };
            flows.end(&flow_id, outcome);
        });
        let started = self
            .count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        // It may have ended already (a sign-in finished at once); keep what it says.
        let entry = open.entry(id).or_insert(Flow {
            view: view.clone(),
            task: None,
            committing: false,
            started,
        });
        if entry.view.state == "waiting" && !entry.committing {
            entry.task = Some(task.abort_handle());
        }
        let shown = entry.view.clone();
        prune(&mut open);
        Ok(shown)
    }

    /// A sign-in as it stands now.
    pub fn view(&self, id: &str) -> Option<FlowView> {
        let open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        open.get(id).map(|f| f.view.clone())
    }

    /// Cancels a waiting sign-in. Returns whether it was waiting.
    pub fn cancel(&self, id: &str) -> bool {
        let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        let Some(flow) = open
            .get_mut(id)
            .filter(|f| f.view.state == "waiting" && !f.committing)
        else {
            return false;
        };
        if let Some(task) = flow.task.take() {
            task.abort();
        }
        flow.view.state = "cancelled";
        flow.view.url = None;
        flow.view.user_code = None;
        true
    }

    /// Marks a finished sign-in as being kept, unless it was cancelled first.
    fn commit(&self, id: &str) -> bool {
        let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        match open.get_mut(id) {
            Some(flow) if flow.view.state == "waiting" => {
                flow.committing = true;
                true
            }
            // Ended before it was registered: nothing could have cancelled it yet.
            None => {
                open.insert(
                    id.to_owned(),
                    Flow {
                        view: FlowView {
                            id: id.to_owned(),
                            method: Method::Browser,
                            state: "waiting",
                            url: None,
                            user_code: None,
                            endpoint: None,
                            error: None,
                        },
                        task: None,
                        committing: true,
                        started: 0,
                    },
                );
                true
            }
            Some(_) => false,
        }
    }

    fn cancel_waiting(&self) {
        let waiting: Vec<String> = {
            let open = self.open.lock().unwrap_or_else(|p| p.into_inner());
            open.iter()
                .filter(|(_, f)| f.view.state == "waiting")
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in waiting {
            self.cancel(&id);
        }
    }

    fn end(&self, id: &str, outcome: Result<String, String>) {
        let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        let flow = open.entry(id.to_owned()).or_insert_with(|| Flow {
            view: FlowView {
                id: id.to_owned(),
                method: Method::Browser,
                state: "waiting",
                url: None,
                user_code: None,
                endpoint: None,
                error: None,
            },
            task: None,
            committing: false,
            started: 0,
        });
        if flow.view.state != "waiting" {
            return;
        }
        flow.task = None;
        flow.committing = false;
        // The link and code are of no use once it ends.
        flow.view.url = None;
        flow.view.user_code = None;
        match outcome {
            Ok(endpoint) => {
                flow.view.state = "done";
                flow.view.endpoint = Some(endpoint);
            }
            Err(error) => {
                flow.view.state = "failed";
                flow.view.error = Some(error);
            }
        }
    }
}

fn waiting(id: &str, method: Method, url: String, user_code: Option<String>) -> FlowView {
    FlowView {
        id: id.to_owned(),
        method,
        state: "waiting",
        url: Some(url),
        user_code,
        endpoint: None,
        error: None,
    }
}

/// A sign-in's tokens, once its ID token is checked against the config, now that it arrived.
fn signed_in(tokens: Tokens, expect: &(crate::Config, crate::Clock)) -> Result<SignedIn, String> {
    let (config, clock) = expect;
    let now = clock();
    let account = claims::account(
        tokens.id_token.as_deref(),
        &tokens.access_token,
        claims::Expect {
            issuer: &config.issuer,
            client_id: &config.client_id,
            now,
        },
    )?;
    Ok(SignedIn { tokens, account })
}

const EXPIRED: &str = "the sign-in code expired; start the sign-in again";

/// Polls a device code until the person approves it, slowing down when the server asks.
async fn poll_until_approved(
    http: reqwest::Client,
    config: crate::Config,
    device: oauth::DeviceCode,
    expect: (crate::Config, crate::Clock),
) -> Result<SignedIn, String> {
    let mut interval = device.interval;
    loop {
        tokio::time::sleep(interval).await;
        match oauth::poll_device(&http, &config, &device)
            .await
            .map_err(line)?
        {
            Poll::Waiting => {}
            // Asked to slow down: five seconds more each time (RFC 8628 §3.5).
            Poll::SlowDown => interval += std::time::Duration::from_secs(5),
            Poll::Approved { code, verifier } => {
                let redirect = oauth::device_redirect(&config);
                let tokens = oauth::exchange(&http, &config, &code, &redirect, &verifier)
                    .await
                    .map_err(line)?;
                return signed_in(tokens, &expect);
            }
        }
    }
}

fn line(error: OauthError) -> String {
    error.to_string()
}

/// Drops the oldest ended sign-ins beyond [`KEPT`].
fn prune(open: &mut HashMap<String, Flow>) {
    let mut ended: Vec<(u64, String)> = open
        .iter()
        .filter(|(_, f)| f.view.state != "waiting")
        .map(|(id, f)| (f.started, id.clone()))
        .collect();
    if ended.len() <= KEPT {
        return;
    }
    ended.sort();
    for (_, id) in ended.iter().take(ended.len() - KEPT) {
        open.remove(id);
    }
}
