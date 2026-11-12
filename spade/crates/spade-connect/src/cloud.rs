//! Spade Cloud (ADR 0140, `spade/docs/cloud.md`): the hosted broker that signs in to apps whose
//! sign-in needs a client secret. Spade shows it the person's ace account credential, a PKCE
//! challenge and a one-time key; the cloud returns the app's tokens sealed to that key. The
//! tokens are then kept as every connector's are, in the keychain. This module is the cloud's
//! client; [`crate::Connectors`] drives the sign-in and renewals with it.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use spade_cloud_wire::{
    ErrorAnswer, FinishAnswer, FinishRequest, RefreshAnswer, RefreshRequest, StartAnswer,
    StartRequest,
};

/// Spade Cloud's address in Spade.
pub const CLOUD_URL: &str = "https://cloud.acehq.dev";

/// Why there is no ace account credential to show the cloud.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountProblem {
    /// This machine isn't signed in to an ace account.
    SignedOut,
    /// ace (the daemon, or its account backend) didn't answer.
    Unreachable(String),
}

pub type Credential<'a> = Pin<Box<dyn Future<Output = Result<String, AccountProblem>> + Send + 'a>>;

/// Where the person's ace account credential comes from: the daemon in Spade, a fake in tests.
pub trait AccountCredential: Send + Sync {
    /// A short-lived machine grant (ADR 0111).
    fn grant(&self) -> Credential<'_>;
}

/// What signing in through the cloud needs.
#[derive(Clone)]
pub struct Cloud {
    /// The cloud's address ([`CLOUD_URL`] in Spade).
    pub url: String,
    pub credential: Arc<dyn AccountCredential>,
}

/// Why the cloud gave no answer Spade can use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CloudError {
    /// Not signed in to ace, so nothing to show the cloud.
    SignedOut,
    /// ace couldn't be asked for the credential.
    AceAway(String),
    /// The cloud didn't answer.
    Unreachable,
    /// The cloud refused, with one of `spade_cloud_wire::refusal`'s codes.
    Refused(String),
}

pub(crate) struct CloudClient {
    url: String,
    credential: Arc<dyn AccountCredential>,
    http: reqwest::Client,
}

impl CloudClient {
    pub(crate) fn new(cloud: &Cloud, timeout: Duration) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .build()
            .unwrap_or_default();
        Self {
            url: cloud.url.trim_end_matches('/').to_owned(),
            credential: cloud.credential.clone(),
            http,
        }
    }

    pub(crate) async fn start(
        &self,
        app: &str,
        request: &StartRequest,
    ) -> Result<StartAnswer, CloudError> {
        self.post(app, "start", request)
            .await
            .map(|(_, answer)| answer)
    }

    pub(crate) async fn finish(
        &self,
        app: &str,
        request: &FinishRequest,
    ) -> Result<FinishAnswer, CloudError> {
        self.post(app, "finish", request)
            .await
            .map(|(_, answer)| answer)
    }

    pub(crate) async fn refresh(
        &self,
        app: &str,
        request: &RefreshRequest,
    ) -> Result<RefreshAnswer, CloudError> {
        self.post(app, "refresh", request)
            .await
            .map(|(_, answer)| answer)
    }

    async fn post<B: Serialize, A: DeserializeOwned>(
        &self,
        app: &str,
        step: &str,
        body: &B,
    ) -> Result<(u16, A), CloudError> {
        if !secure_cloud_url(&self.url) {
            return Err(CloudError::Unreachable);
        }
        let grant = self
            .credential
            .grant()
            .await
            .map_err(|problem| match problem {
                AccountProblem::SignedOut => CloudError::SignedOut,
                AccountProblem::Unreachable(why) => CloudError::AceAway(why),
            })?;
        let response = self
            .http
            .post(format!("{}/v1/oauth/{app}/{step}", self.url))
            .bearer_auth(&grant)
            .json(body)
            .send()
            .await
            .map_err(|_| CloudError::Unreachable)?;
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| CloudError::Unreachable)?;
        if (200..300).contains(&status) {
            return serde_json::from_slice(&bytes)
                .map(|answer| (status, answer))
                .map_err(|_| CloudError::Unreachable);
        }
        match serde_json::from_slice::<ErrorAnswer>(&bytes) {
            Ok(refusal) => Err(CloudError::Refused(refusal.error)),
            // Not the cloud's own refusal: a proxy or load balancer between, so it's away.
            Err(_) => Err(CloudError::Unreachable),
        }
    }
}

fn secure_cloud_url(address: &str) -> bool {
    let Ok(url) = url::Url::parse(address) else {
        return false;
    };
    url.scheme() == "https"
        || (url.scheme() == "http"
            && match url.host() {
                Some(url::Host::Domain(host)) => host == "localhost",
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                None => false,
            })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct NeverCredential;
    impl AccountCredential for NeverCredential {
        fn grant(&self) -> Credential<'_> {
            panic!("unsafe cloud must not obtain credentials")
        }
    }
    #[tokio::test]
    async fn insecure_cloud_is_refused_before_obtaining_a_credential() {
        for address in [
            "http://cloud.acehq.dev",
            "ftp://localhost",
            "http://localhost.evil",
            "broken",
        ] {
            let client = CloudClient::new(
                &Cloud {
                    url: address.into(),
                    credential: Arc::new(NeverCredential),
                },
                Duration::from_secs(1),
            );
            assert!(matches!(
                client
                    .start(
                        "asana",
                        &StartRequest {
                            code_challenge: String::new(),
                            public_key: String::new()
                        }
                    )
                    .await,
                Err(CloudError::Unreachable)
            ));
        }
        for address in [
            "https://cloud.acehq.dev",
            "http://localhost:8080",
            "http://127.0.0.2",
            "http://[::1]:8080",
        ] {
            assert!(secure_cloud_url(address));
        }
    }
}
