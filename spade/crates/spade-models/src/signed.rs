//! Calls on a signed-in account (ADR 0214). A call holds the account's token with the generation
//! of the credential it belongs to, and is sent only while that generation is still the
//! account's: a sign-out, a removal or another sign-in since stops every send not yet made. A
//! token only ever goes to the backend it was issued for, and what fails says only fixed words.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::catalog::Endpoint;
use crate::chatgpt;
use crate::client::Models;
use crate::error::ModelError;
use crate::listing::{self, Listed};

/// An access token and the generation of the credential it belongs to.
#[derive(Clone, PartialEq, Eq)]
pub struct Credential {
    pub token: String,
    pub generation: u64,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Credential(…, generation {})", self.generation)
    }
}

/// What [`Bearers`] answers: a credential, or one plain line saying why there is none.
pub type BearerFuture = Pin<Box<dyn Future<Output = Result<Credential, String>> + Send>>;

type Find = dyn Fn(String) -> BearerFuture + Send + Sync;
type Rejected = dyn Fn(String, Credential) -> BearerFuture + Send + Sync;
type Dispatcher = dyn Fn(String, u64) -> DispatchFuture + Send + Sync;

/// Leave to send under a credential, held until the request is on the wire.
pub type DispatchGuard = Box<dyn std::any::Any + Send>;

/// What a dispatch answers: the leave, or why the credential may not be sent any more.
pub type DispatchFuture = Pin<Box<dyn Future<Output = Result<DispatchGuard, String>> + Send>>;

/// Signed-in accounts' credentials, by account (endpoint) id: `find` one (refreshed when about to
/// end), a new one after the backend `rejected` one (refreshed once however many calls report
/// it, and never another sign-in's), and leave to `dispatch` a request under a generation, held
/// until it is on the wire, so a sign-out never overtakes a send. Only for calls to
/// `backend`'s origin. Tokens are never printed.
#[derive(Clone)]
pub struct Bearers {
    backend: String,
    find: Arc<Find>,
    rejected: Arc<Rejected>,
    dispatch: Arc<Dispatcher>,
}

impl Bearers {
    pub fn new(
        backend: impl Into<String>,
        find: impl Fn(String) -> BearerFuture + Send + Sync + 'static,
        rejected: impl Fn(String, Credential) -> BearerFuture + Send + Sync + 'static,
        dispatch: impl Fn(String, u64) -> DispatchFuture + Send + Sync + 'static,
    ) -> Self {
        Self {
            backend: backend.into(),
            find: Arc::new(find),
            rejected: Arc::new(rejected),
            dispatch: Arc::new(dispatch),
        }
    }
}

impl std::fmt::Debug for Bearers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Bearers(…)")
    }
}

/// The account a call was resolved on and the credential it carries. The account's headers were
/// made from this endpoint once, so a new credential never meets another account's id.
#[derive(Debug, Clone)]
pub(crate) struct Signed {
    pub endpoint: Endpoint,
    pub credential: Credential,
}

/// Said when a call's credential stopped being its account's before a send.
const CHANGED: &str = "This account was signed out, removed or signed in again while the call \
                       was under way; send it again.";

impl Models {
    /// Where signed-in accounts' tokens come from (ADR 0214).
    pub fn set_bearers(&self, bearers: Bearers) {
        *self.bearers.write().unwrap_or_else(|p| p.into_inner()) = Some(bearers);
    }

    /// The account's bearers, once its address is checked against the backend its sign-in is
    /// for: never anywhere else.
    fn bearers_for(&self, endpoint: &Endpoint) -> Result<Bearers, ModelError> {
        let bearers = self
            .bearers
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| refuse(endpoint, "this Spade cannot use sign-in accounts"))?;
        if !crate::base_url::same_origin(&endpoint.base_url, &bearers.backend) {
            return Err(refuse(
                endpoint,
                "this account's address is not the ChatGPT backend, so its sign-in is not sent there",
            ));
        }
        Ok(bearers)
    }

    /// The account's credential now, or why there is none.
    pub(crate) async fn credential(&self, endpoint: &Endpoint) -> Result<Credential, ModelError> {
        let bearers = self.bearers_for(endpoint)?;
        (bearers.find)(endpoint.id.clone())
            .await
            .map_err(|message| refuse(endpoint, &message))
    }

    /// After the backend refused `signed`'s token: the credential its own refresh gives, on the
    /// same account and generation only.
    pub(crate) async fn after_rejection(&self, signed: &Signed) -> Result<Credential, ModelError> {
        let bearers = self.bearers_for(&signed.endpoint)?;
        (bearers.rejected)(signed.endpoint.id.clone(), signed.credential.clone())
            .await
            .map_err(|message| refuse(&signed.endpoint, &message))
    }

    /// Taken before every send and held until the request is on the wire: the credential is
    /// still its account's, and stays so until the guard goes.
    pub(crate) async fn dispatch(&self, signed: &Signed) -> Result<DispatchGuard, ModelError> {
        let bearers = self.bearers_for(&signed.endpoint)?;
        (bearers.dispatch)(signed.endpoint.id.clone(), signed.credential.generation)
            .await
            .map_err(|_| refuse(&signed.endpoint, CHANGED))
    }

    /// A signed-in account's own model list. A `401` gets one new credential from the account's
    /// own refresh and one more try. What fails says only fixed words, never what the backend
    /// sent.
    pub(crate) async fn list_signed(
        &self,
        endpoint: &Endpoint,
        account_id: &str,
    ) -> Result<Vec<Listed>, ModelError> {
        let listing_error = |message: String| ModelError::Listing {
            endpoint: endpoint.id.clone(),
            message,
        };
        let mut signed = Signed {
            endpoint: endpoint.clone(),
            credential: self
                .credential(endpoint)
                .await
                .map_err(|e| listing_error(e.to_string()))?,
        };
        let mut asking = endpoint.clone();
        asking.headers.extend(chatgpt::headers(account_id, None));
        let mut refreshed = false;
        // Every token this listing sent, scrubbed from what it returns.
        let mut sent = vec![signed.credential.token.clone()];
        loop {
            let _sending = self
                .dispatch(&signed)
                .await
                .map_err(|e| listing_error(e.to_string()))?;
            let failure = match listing::fetch(
                &self.http,
                &asking,
                Some(&signed.credential.token),
                &[("client_version", chatgpt::CLIENT_VERSION)],
                self.listing,
            )
            .await
            {
                Ok(listed) => return Ok(without_tokens(listed, &sent)),
                Err(failure) => failure,
            };
            drop(_sending);
            if failure.status == Some(401) && !refreshed {
                refreshed = true;
                let fresh = self
                    .after_rejection(&signed)
                    .await
                    .map_err(|e| listing_error(e.to_string()))?;
                // The same token again would be the same request: the 401 stands.
                if fresh.token != signed.credential.token {
                    sent.push(fresh.token.clone());
                    signed.credential = fresh;
                    continue;
                }
            }
            return Err(listing_error(match failure.status {
                Some(status) => format!("the ChatGPT backend refused the model list ({status})"),
                None => "the ChatGPT backend's model list could not be read".to_owned(),
            }));
        }
    }
}

/// A signed-in account's model list with nothing that carries any of `tokens`: a model whose id
/// holds one is left out, a name that holds one goes, and the raw item is never kept.
fn without_tokens(listed: Vec<Listed>, tokens: &[String]) -> Vec<Listed> {
    let holds = |text: &str| tokens.iter().any(|token| text.contains(token.as_str()));
    listed
        .into_iter()
        .filter(|m| !holds(&m.id))
        .map(|mut m| {
            m.name = m.name.filter(|name| !holds(name));
            m.raw = serde_json::Value::Null;
            m
        })
        .collect()
}

fn refuse(endpoint: &Endpoint, message: &str) -> ModelError {
    ModelError::SignIn {
        endpoint: endpoint.id.clone(),
        message: message.to_owned(),
    }
}
