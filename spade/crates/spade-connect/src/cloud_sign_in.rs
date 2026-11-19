//! Signing in and renewing through Spade Cloud (ADR 0140). A catalogue entry marked
//! `via: "cloud"` signs in with the cloud's client: Spade starts the sign-in at the cloud, opens
//! its authorization address in the person's browser, polls the cloud until the person is back,
//! opens the sealed tokens with its one-time key and keeps them in the keychain. Renewals go
//! through the cloud too. While the cloud or ace is away, a connected app keeps its current
//! token until it expires, and its view says why it can't renew.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use ring::rand::SystemRandom;
use spade_cloud_wire::{
    Context, FinishAnswer, FinishRequest, OneTimeKey, Purpose, RefreshRequest, StartRequest,
    refusal,
};

use crate::catalogue::Via;
use crate::cloud::CloudError;
use crate::hub::{SignedIn, Target};
use crate::oauth::{self, pkce};
use crate::records::{Auth, OauthFacts, Record};
use crate::{ConnectError, ConnectRequest, Connectors, Started, View, lock};

/// How long after a failed renewal through the cloud the next is tried, while the current token
/// is still good.
const RETRY_RENEWAL_MS: i64 = 60_000;

/// Why a connector signed in through the cloud can't renew now; shown on its row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Notice {
    CloudUnreachable,
    AceSignedOut,
    AceUnreachable,
}

impl Notice {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Notice::CloudUnreachable => "cloud_unreachable",
            Notice::AceSignedOut => "ace_signed_out",
            Notice::AceUnreachable => "ace_unreachable",
        }
    }
}

/// A sign-in through the cloud waiting for the person.
pub(crate) struct CloudSignIn {
    serial: u64,
    name: String,
    url: String,
    catalogue: String,
    local: bool,
    poller: tokio::task::AbortHandle,
}

/// What renewing through the cloud found.
pub(crate) enum Renewal {
    Renewed(oauth::Tokens),
    /// The app refused the refresh token: the person signs in again.
    Refused,
    /// The cloud or ace is away; try later. The view shows the notice.
    Away(String),
}

struct Poller {
    id: String,
    serial: u64,
    epoch: u64,
    app: String,
    sign_in: String,
    verifier: String,
    key: OneTimeKey,
    issuer: String,
    client_id: String,
    expires_at_ms: i64,
}

impl Connectors {
    /// The catalogue entry `target` signs in to through the cloud, if it does: an entry marked
    /// `via: "cloud"`, at the entry's own address, with no client the person gives now or gave
    /// before. The person's own client ID keeps working as before.
    pub(crate) fn cloud_app(&self, target: &Target, request: &ConnectRequest) -> Option<String> {
        self.cloud.as_ref()?;
        let connector = target.catalogue.as_deref()?;
        let entry = self.catalogue.iter().find(|entry| {
            entry.id == connector
                && entry.via == Some(Via::Cloud)
                && oauth::wellknown::checked(&entry.url).is_ok_and(|url| url == target.url)
        })?;
        let given = |value: &Option<String>| value.as_deref().is_some_and(|v| !v.trim().is_empty());
        if given(&request.client_id) || given(&request.client_secret) {
            return None;
        }
        let own_before = matches!(
            &target.existing,
            Some(Record { auth: Auth::Oauth(facts), .. }) if !facts.cloud
        );
        (!own_before).then(|| entry.id.clone())
    }

    /// Starts a sign-in through the cloud for catalogue entry `app` and its poller.
    pub(crate) async fn start_cloud(
        self: &Arc<Self>,
        target: Target,
        app: String,
    ) -> Result<Started, ConnectError> {
        let cloud = self
            .cloud
            .as_ref()
            .ok_or_else(|| ConnectError::Failed("Spade Cloud is off".into()))?;
        if self.keys.is_none() {
            return Err(ConnectError::NoKeychain);
        }
        let verifier = pkce::random_value(self.random.as_ref()).map_err(ConnectError::Failed)?;
        let key = OneTimeKey::generate(&SystemRandom::new())
            .map_err(|e| ConnectError::Failed(e.to_string()))?;
        let request = StartRequest {
            code_challenge: pkce::challenge(&verifier),
            public_key: key.public_key(),
        };
        let epoch = self.epoch(&target.id);
        let started = cloud
            .start(&app, &request)
            .await
            .map_err(|error| start_error(&target.name, error))?;
        let address = oauth::wellknown::checked(&started.authorization_url)
            .map_err(|_| ConnectError::Failed("Spade Cloud gave an unusable address".into()))?;
        if address.scheme() != "https" && !target.local {
            return Err(ConnectError::Failed(
                "Spade Cloud gave an address that isn't https".into(),
            ));
        }
        let now = self.now();
        let serial = self.cloud_serial.fetch_add(1, Ordering::SeqCst) + 1;
        let poller = Poller {
            id: target.id.clone(),
            serial,
            epoch,
            app: app.clone(),
            sign_in: started.sign_in,
            verifier,
            key,
            issuer: started.issuer,
            client_id: started.client_id,
            expires_at_ms: now + crate::hub::seconds_ms(started.expires_in),
        };
        let _writing = self.writes.lock().await;
        if self.epoch(&target.id) != epoch {
            return Err(ConnectError::Failed(
                "the app was disconnected meanwhile".into(),
            ));
        }
        // One sign-in per connector: this one replaces any other.
        lock(&self.pending).retain(|_, p| p.id != target.id);
        self.drop_device(&target.id);
        self.drop_cloud(&target.id);
        let hub = self.clone();
        let task = tokio::spawn(async move { hub.poll_cloud(poller).await });
        lock(&self.cloud_sign_ins).insert(
            target.id.clone(),
            CloudSignIn {
                serial,
                name: target.name,
                url: target.url.to_string(),
                catalogue: app,
                local: target.local,
                poller: task.abort_handle(),
            },
        );
        Ok(Started::SignIn {
            id: target.id,
            url: started.authorization_url,
        })
    }

    /// Asks the cloud every three seconds until the person is back, then keeps the tokens.
    async fn poll_cloud(self: Arc<Self>, poller: Poller) {
        let Some(cloud) = self.cloud.as_ref() else {
            return;
        };
        let request = FinishRequest {
            sign_in: poller.sign_in.clone(),
            code_verifier: poller.verifier.clone(),
        };
        let sealed = loop {
            tokio::time::sleep(self.tick.saturating_mul(3)).await;
            if self.now() >= poller.expires_at_ms {
                return self.end_cloud(&poller.id, poller.serial, "the sign-in took too long");
            }
            match cloud.finish(&poller.app, &request).await {
                Ok(FinishAnswer::Waiting) => {}
                Ok(FinishAnswer::Done { sealed }) => break sealed,
                // Away for now: the sign-in may still finish within its window.
                Err(CloudError::Unreachable | CloudError::AceAway(_)) => {}
                Err(CloudError::SignedOut) => {
                    return self.end_cloud(
                        &poller.id,
                        poller.serial,
                        "this machine was signed out of ace",
                    );
                }
                Err(CloudError::Refused(code)) => {
                    let why = match code.as_str() {
                        refusal::DECLINED => "the sign-in was cancelled or refused",
                        refusal::EXPIRED => "the sign-in took too long",
                        _ => "Spade Cloud couldn't finish the sign-in",
                    };
                    return self.end_cloud(&poller.id, poller.serial, why);
                }
            }
        };
        let context = Context {
            app: &poller.app,
            purpose: Purpose::Finish,
        };
        let tokens = match poller.key.open(&sealed, context) {
            Ok(bytes) => oauth::tokens_from_json(&bytes),
            Err(_) => {
                return self.end_cloud(
                    &poller.id,
                    poller.serial,
                    "Spade Cloud's answer didn't open",
                );
            }
        };
        let tokens = match tokens {
            Ok(tokens) => tokens,
            Err(_) => {
                return self.end_cloud(
                    &poller.id,
                    poller.serial,
                    "the app's tokens weren't usable",
                );
            }
        };
        let signed = {
            let sign_ins = lock(&self.cloud_sign_ins);
            let Some(sign_in) = sign_ins
                .get(&poller.id)
                .filter(|s| s.serial == poller.serial)
            else {
                return;
            };
            SignedIn {
                id: poller.id.clone(),
                name: sign_in.name.clone(),
                url: sign_in.url.clone(),
                catalogue: Some(sign_in.catalogue.clone()),
                local: sign_in.local,
                issuer: poller.issuer.clone(),
                // Renewals go through the cloud, never to the maker directly.
                token_endpoint: String::new(),
                resource: sign_in.url.clone(),
                client: oauth::Client {
                    id: poller.client_id.clone(),
                    secret: None,
                    auth_method: "cloud".into(),
                    registered_redirect: None,
                    metadata_document: false,
                },
                shipped: false,
                cloud: true,
                scopes: tokens
                    .scope
                    .as_deref()
                    .map(oauth::split_scopes)
                    .unwrap_or_default(),
                tokens,
            }
        };
        match self.keep_sign_in(signed, poller.epoch).await {
            Ok(_) => {
                self.clear_cloud_notice(&poller.id);
                self.forget_cloud(&poller.id, poller.serial);
            }
            Err(why) => self.end_cloud(&poller.id, poller.serial, &why),
        }
    }

    fn end_cloud(&self, id: &str, serial: u64, why: &str) {
        tracing::warn!(connector = %id, %why, "a sign-in through Spade Cloud ended");
        self.forget_cloud(id, serial);
    }

    fn forget_cloud(&self, id: &str, serial: u64) {
        let mut sign_ins = lock(&self.cloud_sign_ins);
        if sign_ins.get(id).is_some_and(|s| s.serial == serial) {
            sign_ins.remove(id);
        }
    }

    /// Stops and forgets `id`'s sign-in through the cloud. Whether there was one.
    pub(crate) fn drop_cloud(&self, id: &str) -> bool {
        match lock(&self.cloud_sign_ins).remove(id) {
            Some(sign_in) => {
                sign_in.poller.abort();
                true
            }
            None => false,
        }
    }

    pub(crate) fn cloud_signing_in(&self, id: &str) -> bool {
        lock(&self.cloud_sign_ins).contains_key(id)
    }

    /// Sign-ins through the cloud of connectors not yet kept, as views.
    pub(crate) fn cloud_views_without_records(&self, shown: &[View]) -> Vec<View> {
        lock(&self.cloud_sign_ins)
            .iter()
            .filter(|(id, _)| !shown.iter().any(|v| &v.id == *id))
            .map(|(id, sign_in)| View {
                id: id.clone(),
                name: sign_in.name.clone(),
                url: sign_in.url.clone(),
                catalogue: Some(sign_in.catalogue.clone()),
                local: sign_in.local,
                sign_in: "oauth",
                state: "signing_in",
                account: None,
                tools: 0,
                problem: None,
                device: None,
                via: Some("cloud"),
                notice: None,
            })
            .collect()
    }

    /// Renews `record`'s tokens through the cloud with its refresh token.
    pub(crate) async fn cloud_refresh(&self, record: &Record, refresh: &str) -> Renewal {
        let (Some(cloud), Some(app)) = (self.cloud.as_ref(), record.catalogue.as_deref()) else {
            return Renewal::Refused;
        };
        let key = match OneTimeKey::generate(&SystemRandom::new()) {
            Ok(key) => key,
            Err(why) => return Renewal::Away(why.to_string()),
        };
        let request = RefreshRequest {
            refresh_token: refresh.to_owned(),
            public_key: key.public_key(),
        };
        let answer = match cloud.refresh(app, &request).await {
            Ok(answer) => answer,
            Err(error) => {
                let (notice, why) = match error {
                    CloudError::Refused(code) if code == refusal::REFUSED => {
                        return Renewal::Refused;
                    }
                    CloudError::SignedOut => (
                        Notice::AceSignedOut,
                        "sign in to ace to keep this app signed in".to_owned(),
                    ),
                    CloudError::AceAway(_) => {
                        (Notice::AceUnreachable, "ace can't be reached".to_owned())
                    }
                    CloudError::Unreachable | CloudError::Refused(_) => (
                        Notice::CloudUnreachable,
                        "Spade Cloud can't be reached".to_owned(),
                    ),
                };
                self.set_cloud_notice(&record.id, notice);
                return Renewal::Away(why);
            }
        };
        let context = Context {
            app,
            purpose: Purpose::Refresh,
        };
        match key
            .open(&answer.sealed, context)
            .ok()
            .and_then(|bytes| oauth::tokens_from_json(&bytes).ok())
        {
            Some(tokens) => {
                self.clear_cloud_notice(&record.id);
                Renewal::Renewed(tokens)
            }
            None => {
                self.set_cloud_notice(&record.id, Notice::CloudUnreachable);
                Renewal::Away("Spade Cloud's answer didn't open".into())
            }
        }
    }

    /// Whether `facts`' token is signed in through the cloud, still good, and a renewal failed
    /// so recently that the next waits: the current token is used meanwhile.
    pub(crate) fn cloud_waiting_to_renew(&self, id: &str, facts: &OauthFacts) -> bool {
        facts.cloud
            && self.cloud_token_good(facts)
            && lock(&self.cloud_notices)
                .get(id)
                .is_some_and(|(_, at)| self.now() - at < RETRY_RENEWAL_MS)
    }

    /// Whether a token signed in through the cloud hasn't expired yet.
    pub(crate) fn cloud_token_good(&self, facts: &OauthFacts) -> bool {
        facts.cloud && facts.expires_at_ms.is_none_or(|at| at > self.now())
    }

    pub(crate) fn cloud_notice(&self, id: &str) -> Option<&'static str> {
        lock(&self.cloud_notices).get(id).map(|(n, _)| n.code())
    }

    fn set_cloud_notice(&self, id: &str, notice: Notice) {
        let now = self.now();
        lock(&self.cloud_notices).insert(id.to_owned(), (notice, now));
    }

    pub(crate) fn clear_cloud_notice(&self, id: &str) {
        lock(&self.cloud_notices).remove(id);
    }
}

fn start_error(name: &str, error: CloudError) -> ConnectError {
    match error {
        CloudError::SignedOut => ConnectError::NeedsAceAccount,
        CloudError::AceAway(why) => {
            ConnectError::Unreachable(format!("ace can't be reached: {why}"))
        }
        CloudError::Unreachable => ConnectError::Unreachable("Spade Cloud can't be reached".into()),
        CloudError::Refused(code) => match code.as_str() {
            refusal::APP_UNAVAILABLE | refusal::UNKNOWN_APP => ConnectError::Unsupported(format!(
                "Spade Cloud can't sign in to {name} yet; use your own client ID"
            )),
            refusal::UNAUTHORIZED => ConnectError::Failed(
                "Spade Cloud didn't accept this machine's ace account; sign in to ace again".into(),
            ),
            refusal::RATE_LIMITED => {
                ConnectError::Failed("Spade Cloud is busy; try again in a minute".into())
            }
            _ => ConnectError::Failed("Spade Cloud couldn't start the sign-in".into()),
        },
    }
}
