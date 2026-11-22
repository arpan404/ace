//! This month's ace searches against the allowance, from `GET {cloud}/v1/search/usage`, for the
//! one quiet line in Settings › Spade › General (ADR 0210 §6).

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::{ACE_CLIENT_HEADER, wire};

/// How long the settings line waits for the cloud.
const WAIT: Duration = Duration::from_secs(5);

/// What Spade's `GET /v1/usage/search` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Usage {
    pub signed_in: bool,
    pub used: Option<u64>,
    pub allowance: Option<u64>,
    pub resets_at: Option<String>,
}

impl Usage {
    pub fn signed_out() -> Self {
        Self {
            signed_in: false,
            used: None,
            allowance: None,
            resets_at: None,
        }
    }

    /// Signed in, but the counts couldn't be had.
    pub fn unknown() -> Self {
        Self {
            signed_in: true,
            ..Self::signed_out()
        }
    }

    /// Reads the cloud's `{month: {used, allowance}, day: {...}, resetsAt}` leniently.
    fn from_cloud(page: &Value) -> Self {
        let month = page.get("month");
        let count = |field: &str| month.and_then(|m| m.get(field)).and_then(Value::as_u64);
        Self {
            signed_in: true,
            used: count("used"),
            allowance: count("allowance"),
            resets_at: page
                .get("resetsAt")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }
}

pub(crate) async fn ask(
    http: &reqwest::Client,
    url: &str,
    grant: &str,
    ace_client: Option<&str>,
) -> Usage {
    let mut request = http
        .get(format!("{url}/v1/search/usage"))
        .bearer_auth(grant)
        .timeout(WAIT);
    if let Some(name) = ace_client {
        request = request.header(ACE_CLIENT_HEADER, name);
    }
    let Ok(response) = request.send().await else {
        return Usage::unknown();
    };
    match response.status().as_u16() {
        200 => match wire::json_body(response, wire::MOST_BODY_BYTES).await {
            Ok(page) => Usage::from_cloud(&page),
            Err(_) => Usage::unknown(),
        },
        401 | 403 => Usage::signed_out(),
        _ => Usage::unknown(),
    }
}
