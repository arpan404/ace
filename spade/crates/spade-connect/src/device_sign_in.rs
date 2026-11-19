//! Device sign-ins (RFC 8628) with Spade's own registered apps (ADR 0137): the code the person
//! enters on the app's page, the poller that waits for them, and how the connector's view shows
//! it. Tokens are kept exactly as a browser sign-in's are ([`Connectors::keep_sign_in`]), so the
//! connector is then like any other: keychain only, per-bot allow lists, untrusted output.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde::Serialize;

use crate::apps::App;
use crate::hub::{SignedIn, Target, from_oauth};
use crate::oauth::{self, AuthServer, Resource, device};
use crate::{ConnectError, Connectors, SIGN_IN_WINDOW_MS, Started, View, lock};

/// How a device sign-in stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    Waiting,
    Expired,
    Denied,
    Failed(String),
}

pub(crate) struct DeviceSignIn {
    serial: u64,
    name: String,
    url: String,
    catalogue: Option<String>,
    local: bool,
    code: String,
    page: String,
    expires_at_ms: i64,
    outcome: Outcome,
    /// When it stopped waiting; kept a while after so the app can say why.
    ended_ms: Option<i64>,
    poller: tokio::task::AbortHandle,
}

/// What the app shows of a device sign-in. The code is meant to be seen: the person types it
/// on the app's own page. The device code Spade polls with is never shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceView {
    pub code: String,
    /// The app's page for entering the code.
    pub url: String,
    /// `waiting`, `expired`, `denied` or `failed`.
    pub state: &'static str,
    pub expires_at_ms: i64,
}

impl DeviceView {
    pub fn waiting(&self) -> bool {
        self.state == "waiting"
    }
}

fn view_of(sign_in: &DeviceSignIn) -> DeviceView {
    DeviceView {
        code: sign_in.code.clone(),
        url: sign_in.page.clone(),
        state: match sign_in.outcome {
            Outcome::Waiting => "waiting",
            Outcome::Expired => "expired",
            Outcome::Denied => "denied",
            Outcome::Failed(_) => "failed",
        },
        expires_at_ms: sign_in.expires_at_ms,
    }
}

/// What the poller needs, fixed when the sign-in started.
struct Poller {
    id: String,
    serial: u64,
    epoch: u64,
    net: oauth::Net,
    server: AuthServer,
    client: oauth::Client,
    scopes: Vec<String>,
    resource: String,
    device_code: String,
    interval: u64,
    expires_at_ms: i64,
}

impl Connectors {
    /// Starts a device sign-in with Spade's own `app` at `server`, and its poller.
    pub(crate) async fn start_device(
        self: &Arc<Self>,
        net: oauth::Net,
        target: Target,
        resource: Resource,
        server: AuthServer,
        app: &App,
    ) -> Result<Started, ConnectError> {
        let endpoint = server
            .device_authorization_endpoint
            .clone()
            .ok_or_else(|| {
                ConnectError::Unsupported(format!(
                    "{} no longer offers the device sign-in Spade's app uses",
                    target.name
                ))
            })?;
        let client = oauth::Client {
            id: app.client_id.clone(),
            secret: None,
            auth_method: "none".into(),
            registered_redirect: None,
            metadata_document: false,
        };
        let scopes = match &app.scopes {
            Some(scopes) => scopes.clone(),
            None => oauth::with_offline_access(resource.scopes, &server),
        };
        let started = device::start(&net, &endpoint, &client, &scopes, &resource.resource)
            .await
            .map_err(from_oauth)?;
        let now = self.now();
        let expires_at_ms = now + crate::hub::seconds_ms(started.expires_in);
        let serial = self.device_serial.fetch_add(1, Ordering::SeqCst) + 1;
        let poller = Poller {
            id: target.id.clone(),
            serial,
            epoch: self.epoch(&target.id),
            net,
            server,
            client,
            scopes,
            resource: resource.resource,
            device_code: started.device_code.clone(),
            interval: started.interval,
            expires_at_ms,
        };
        let page = started
            .verification_uri_complete
            .clone()
            .unwrap_or_else(|| started.verification_uri.clone());
        // One sign-in per connector: this one replaces any other.
        lock(&self.pending).retain(|_, p| p.id != target.id);
        self.drop_device(&target.id);
        let hub = self.clone();
        let task = tokio::spawn(async move { hub.poll_device(poller).await });
        lock(&self.devices).insert(
            target.id.clone(),
            DeviceSignIn {
                serial,
                name: target.name,
                url: target.url.to_string(),
                catalogue: target.catalogue,
                local: target.local,
                code: started.user_code.clone(),
                page: page.clone(),
                expires_at_ms,
                outcome: Outcome::Waiting,
                ended_ms: None,
                poller: task.abort_handle(),
            },
        );
        Ok(Started::Device {
            id: target.id,
            code: started.user_code,
            url: page,
            expires_in: started.expires_in,
        })
    }

    /// Polls until the person approves, declines, or the code expires, waiting the server's
    /// interval between polls and five seconds more after each `slow_down` (RFC 8628 3.5).
    async fn poll_device(self: Arc<Self>, poller: Poller) {
        let mut interval = poller.interval;
        loop {
            let wait = self
                .tick
                .saturating_mul(u32::try_from(interval).unwrap_or(u32::MAX));
            tokio::time::sleep(wait).await;
            if self.now() >= poller.expires_at_ms {
                return self.end_device(&poller, Outcome::Expired);
            }
            let poll = device::poll(
                &poller.net,
                &poller.server.token_endpoint,
                &poller.client,
                &poller.device_code,
                &poller.resource,
            )
            .await;
            interval = device::next_interval(interval, &poll);
            let tokens = match poll {
                device::Poll::Pending | device::Poll::SlowDown => continue,
                device::Poll::Expired => return self.end_device(&poller, Outcome::Expired),
                device::Poll::Denied => return self.end_device(&poller, Outcome::Denied),
                device::Poll::Failed(why) => {
                    return self.end_device(&poller, Outcome::Failed(why));
                }
                device::Poll::Done(tokens) => tokens,
            };
            let Some(signed) = self.signed_in(&poller, tokens) else {
                return;
            };
            match self.keep_sign_in(signed, poller.epoch).await {
                Ok(_) => {
                    let mut devices = lock(&self.devices);
                    if devices
                        .get(&poller.id)
                        .is_some_and(|d| d.serial == poller.serial)
                    {
                        devices.remove(&poller.id);
                    }
                }
                Err(why) => self.end_device(&poller, Outcome::Failed(why)),
            }
            return;
        }
    }

    fn signed_in(&self, poller: &Poller, tokens: oauth::Tokens) -> Option<SignedIn> {
        let devices = lock(&self.devices);
        let sign_in = devices
            .get(&poller.id)
            .filter(|d| d.serial == poller.serial)?;
        Some(SignedIn {
            id: poller.id.clone(),
            name: sign_in.name.clone(),
            url: sign_in.url.clone(),
            catalogue: sign_in.catalogue.clone(),
            local: sign_in.local,
            issuer: poller.server.issuer.clone(),
            token_endpoint: poller.server.token_endpoint.clone(),
            resource: poller.resource.clone(),
            client: poller.client.clone(),
            shipped: true,
            cloud: false,
            scopes: poller.scopes.clone(),
            tokens,
        })
    }

    fn end_device(&self, poller: &Poller, outcome: Outcome) {
        let now = self.now();
        if let Some(sign_in) = lock(&self.devices)
            .get_mut(&poller.id)
            .filter(|d| d.serial == poller.serial)
        {
            if let Outcome::Failed(why) = &outcome {
                tracing::warn!(connector = %poller.id, %why, "a device sign-in failed");
            }
            sign_in.outcome = outcome;
            sign_in.ended_ms = Some(now);
        }
    }

    /// Stops and forgets `id`'s device sign-in. Whether there was one.
    pub(crate) fn drop_device(&self, id: &str) -> bool {
        match lock(&self.devices).remove(id) {
            Some(sign_in) => {
                sign_in.poller.abort();
                true
            }
            None => false,
        }
    }

    /// `id`'s device sign-in, while waiting or for a while after it ended.
    pub(crate) fn device_view(&self, id: &str) -> Option<DeviceView> {
        let now = self.now();
        let mut devices = lock(&self.devices);
        devices.retain(|_, d| {
            d.ended_ms
                .is_none_or(|ended| now - ended < SIGN_IN_WINDOW_MS)
        });
        devices.get(id).map(view_of)
    }

    /// Device sign-ins of connectors not yet kept, as views.
    pub(crate) fn device_views_without_records(&self, shown: &[View]) -> Vec<View> {
        let ids: Vec<String> = lock(&self.devices).keys().cloned().collect();
        ids.into_iter()
            .filter(|id| !shown.iter().any(|v| &v.id == id))
            .filter_map(|id| {
                let device = self.device_view(&id)?;
                let devices = lock(&self.devices);
                let sign_in = devices.get(&id)?;
                Some(View {
                    id: id.clone(),
                    name: sign_in.name.clone(),
                    url: sign_in.url.clone(),
                    catalogue: sign_in.catalogue.clone(),
                    local: sign_in.local,
                    sign_in: "oauth",
                    state: if device.waiting() {
                        "signing_in"
                    } else {
                        "needs_reconnect"
                    },
                    account: None,
                    tools: 0,
                    problem: match &sign_in.outcome {
                        Outcome::Failed(why) => Some(why.clone()),
                        _ => None,
                    },
                    device: Some(device),
                    via: None,
                    notice: None,
                })
            })
            .collect()
    }

    /// The server a device sign-in that never connected was for, to try it again.
    pub(crate) fn device_target(&self, id: &str) -> Option<Target> {
        let devices = lock(&self.devices);
        let sign_in = devices.get(id)?;
        let url = oauth::wellknown::checked(&sign_in.url).ok()?;
        Some(Target {
            id: id.to_owned(),
            name: sign_in.name.clone(),
            url,
            catalogue: sign_in.catalogue.clone(),
            local: sign_in.local,
            existing: None,
        })
    }
}
