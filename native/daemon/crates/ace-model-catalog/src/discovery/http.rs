// SPDX-License-Identifier: Apache-2.0
//! The HTTP port: one GET to a provider's own endpoint, as the provider CLI would make it.

use crate::failures::DiscoveryFailure;

/// One catalog request. Headers carry only what the provider needs; no credential is
/// logged, stored or returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

/// A reply's status and body. A non-2xx status is a value, not an error: the caller
/// classifies it (401/403 `auth_expired`, 429 `rate_limited`, 5xx `unreachable`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    pub body: String,
}

/// The client a discovery port is given.
pub trait HttpGet: Send + Sync {
    /// Reads `request`, stopping as soon as `aborted` says so.
    #[allow(clippy::result_large_err)]
    fn get(
        &self,
        request: &HttpRequest,
        aborted: &dyn Fn() -> bool,
    ) -> Result<HttpReply, DiscoveryFailure>;
}
