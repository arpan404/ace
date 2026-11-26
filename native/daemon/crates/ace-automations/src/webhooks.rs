// SPDX-License-Identifier: Apache-2.0
//! Webhook automations beyond the primitives, ported from `packages/automations/src/webhooks.ts`
//! (ADR 0173): the person's rotate/revoke controls and what one signed request does. No HTTP
//! here: the daemon hands in the method, headers and raw body and sends the answer back.

use crate::error::{AutomationsError, Result};
use crate::scheduler::Clock;
use crate::service::Service;
use crate::store::AutomationStore;
use crate::webhook_body::{WEBHOOK_BODY_LIMITS, webhook_variables};
use crate::webhook_secret_box::{SecretBox, new_webhook_secret};
use crate::webhook_signature::{WebhookCheck, read_webhook_headers, verify_webhook};

/// A hook id in a URL: 128 bits in lowercase hex.
pub fn valid_hook_id(hook_id: &str) -> bool {
    hook_id.len() == 32
        && hook_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub struct WebhookDeps<'a> {
    pub clock: &'a dyn Clock,
    /// `size` random bytes; the daemon supplies the OS's.
    pub random: &'a dyn Fn(usize) -> Vec<u8>,
    /// Counts one new delivery per automation; false refuses it. Asked only after the
    /// signature verifies, so a caller without the secret can't spend a sender's room.
    pub allow: Option<&'a dyn Fn(&str) -> bool>,
}

pub struct WebhookRequest<'a> {
    pub method: &'a str,
    pub content_type: Option<&'a str>,
    pub id: Option<&'a str>,
    pub timestamp: Option<&'a str>,
    pub signature: Option<&'a str>,
    pub body: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookAnswer {
    pub status: u16,
    pub error: Option<&'static str>,
    pub message: Option<String>,
    pub run_id: Option<String>,
}

impl WebhookAnswer {
    fn refused(error: &'static str, message: Option<String>) -> WebhookAnswer {
        let status = match error {
            "method_not_allowed" => 405,
            "not_found" => 404,
            "too_large" => 413,
            "unsupported_media_type" => 415,
            "bad_headers" => 400,
            "stale_timestamp" => 400,
            "bad_signature" => 401,
            "bad_body" => 422,
            "disabled" => 409,
            "rate_limited" => 429,
            _ => 503,
        };
        WebhookAnswer {
            status,
            error: Some(error),
            message,
            run_id: None,
        }
    }

    fn accepted(run_id: String) -> WebhookAnswer {
        WebhookAnswer {
            status: 202,
            error: None,
            message: None,
            run_id: Some(run_id),
        }
    }
}

pub struct RotatedSecret {
    pub hook_id: String,
    pub secret: String,
}

pub struct Webhooks<'a> {
    store: &'a AutomationStore,
    deps: WebhookDeps<'a>,
    key: Option<&'a SecretBox>,
}

impl<'a> Webhooks<'a> {
    pub fn new(
        store: &'a AutomationStore,
        deps: WebhookDeps<'a>,
        key: Option<&'a SecretBox>,
    ) -> Webhooks<'a> {
        Webhooks { store, deps, key }
    }

    /// A new secret and its hook id (kept after the first rotation).
    pub fn rotate(&self, automation_id: &str) -> Result<RotatedSecret> {
        let Some(automation) = self.store.definition(automation_id)? else {
            return Err(AutomationsError::message("Automation is missing"));
        };
        if automation.trigger.kind() != "webhook" {
            return Err(AutomationsError::message("Automation isn't a webhook"));
        }
        let Some(key) = self.key else {
            return Err(AutomationsError::message(
                "Webhook secrets need a key on this machine",
            ));
        };
        let random = self.deps.random;
        let secret = new_webhook_secret(fixed::<32>(&random(32)));
        let hook_id = encode_random_hex(&fixed::<16>(&random(16)));
        let iv = fixed::<12>(&random(12));
        let sealed = key
            .seal(&secret, automation_id, iv)
            .ok_or_else(|| AutomationsError::message("Could not seal the webhook secret"))?;
        let kept = self
            .store
            .webhook_rotate(automation_id, &hook_id, &sealed)?;
        Ok(RotatedSecret {
            hook_id: kept,
            secret,
        })
    }

    /// Deletes the secret and hook id; the URL answers 404 from the next request.
    pub fn revoke(&self, automation_id: &str) -> Result<()> {
        self.store.forget_webhook(automation_id)
    }

    pub fn owner_of(&self, hook_id: &str) -> Result<Option<String>> {
        if !valid_hook_id(hook_id) {
            return Ok(None);
        }
        Ok(self.store.webhook_by_hook(hook_id)?.map(|(owner, _)| owner))
    }

    pub fn hook_of(&self, automation_id: &str) -> Result<Option<String>> {
        self.store.webhook_hook(automation_id)
    }

    /// One request to `/hooks/<hookId>`, checks in the ADR's order.
    pub fn receive(
        &self,
        service: &mut Service<'_>,
        hook_id: &str,
        request: &WebhookRequest<'_>,
    ) -> WebhookAnswer {
        if request.method != "POST" {
            return WebhookAnswer::refused("method_not_allowed", None);
        }
        let key = if valid_hook_id(hook_id) {
            self.store.webhook_by_hook(hook_id).ok().flatten()
        } else {
            None
        };
        let Some((automation_id, sealed)) = key else {
            return WebhookAnswer::refused("not_found", None);
        };
        let Ok(Some(automation)) = self.store.definition(&automation_id) else {
            return WebhookAnswer::refused("not_found", None);
        };
        if automation.trigger.kind() != "webhook" {
            return WebhookAnswer::refused("not_found", None);
        }
        if request.body.len() > WEBHOOK_BODY_LIMITS.bytes {
            return WebhookAnswer::refused("too_large", None);
        }
        let json = request.content_type.is_some_and(|value| {
            let lower = value.to_ascii_lowercase();
            lower == "application/json"
                || lower.starts_with("application/json;")
                || lower
                    .strip_prefix("application/json")
                    .is_some_and(|rest| rest.starts_with(' ') || rest.starts_with('\t'))
        });
        if !json {
            return WebhookAnswer::refused("unsupported_media_type", None);
        }
        let Ok(headers) = read_webhook_headers(request.id, request.timestamp, request.signature)
        else {
            return WebhookAnswer::refused("bad_headers", None);
        };
        let secret = match self.key {
            Some(key) => key.open(&sealed, &automation_id),
            None => None,
        };
        let Some(secret) = secret else {
            return WebhookAnswer::refused(
                "unavailable",
                Some("Its secret can't be read on this machine; rotate it.".to_owned()),
            );
        };
        match verify_webhook(&secret, &headers, request.body, self.deps.clock.now_ms()) {
            WebhookCheck::Ok => {}
            WebhookCheck::StaleTimestamp => return WebhookAnswer::refused("stale_timestamp", None),
            WebhookCheck::BadSignature => return WebhookAnswer::refused("bad_signature", None),
        }
        let variables = match webhook_variables(request.body, &headers.id) {
            Ok(variables) => variables,
            Err(error) => {
                return WebhookAnswer::refused(error.code(), Some(error.message().to_owned()));
            }
        };
        if !automation.enabled {
            return WebhookAnswer::refused("disabled", None);
        }
        let event_key = format!("webhook:{}", headers.id);
        if let Ok(Some(earlier)) = self.store.webhook_delivered(&automation_id, &event_key) {
            return WebhookAnswer::accepted(earlier);
        }
        if let Some(allow) = self.deps.allow
            && !allow(&automation_id)
        {
            return WebhookAnswer::refused("rate_limited", None);
        }
        match service.trigger(&automation_id, &event_key, variables, "webhook", None) {
            Ok(run) => {
                let run_id = run
                    .as_object()
                    .and_then(|object| object.get("id"))
                    .and_then(ace_json::Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                WebhookAnswer::accepted(run_id)
            }
            Err(_) => WebhookAnswer::refused("unavailable", None),
        }
    }
}

/// A fresh hook id as `rotate` writes it, for callers that only need the id's shape.
pub fn encode_random_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn fixed<const N: usize>(bytes: &[u8]) -> [u8; N] {
    let mut out = [0u8; N];
    let take = bytes.len().min(N);
    out[..take].copy_from_slice(&bytes[..take]);
    out
}
