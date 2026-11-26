// SPDX-License-Identifier: Apache-2.0
//! The daemon's own client to another daemon (`apps/daemon/src/client-access.ts`): the pairing
//! link it reads, the request it makes with a pinned key, the failure text a person sees, and the
//! fingerprint rules its TLS connector applies. The handshake itself lives in `ace-transport`'s
//! pinned verifier; everything here is pure so a test needs no certificate.

use url::Url;

/// A client failure as `@ace/client`'s `ClientError` carries it (`code` and `message`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientError {
    pub code: &'static str,
    pub message: String,
}

impl ClientError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// The longest refusal detail a client keeps (`client-access.ts:30`), counted in UTF-16 units
/// as `.slice(0, 512)` counts them.
pub const ACCESS_DETAIL_UTF16: usize = 512;
/// A response past this is refused rather than buffered (`client-access.ts:185`).
pub const RESPONSE_LIMIT: usize = 1_024 * 1_024;

/// `accessResponseError(status)`: an auth refusal, an offline or failing daemon, or a daemon
/// answering something else.
pub fn access_response_error(status: u16) -> ClientError {
    let code = if status == 401 || status == 403 {
        "auth"
    } else if status == 429 || status >= 500 {
        "offline"
    } else {
        "daemon"
    };
    ClientError::new(code, format!("HTTP {status}"))
}

/// The daemon's refusal text is actionable (for example "Turn on remote access"), so it is kept
/// after the status, up to the detail cap.
pub fn access_failure(status: u16, body: &str) -> ClientError {
    let failure = access_response_error(status);
    let detail = ace_json::parse(body).ok().and_then(|value| {
        value
            .get("error")
            .and_then(|error| error.as_str())
            .map(str::to_owned)
    });
    match detail {
        Some(detail) => ClientError::new(
            failure.code,
            format!(
                "{}: {}",
                failure.message,
                truncate_utf16(&detail, ACCESS_DETAIL_UTF16)
            ),
        ),
        None => failure,
    }
}

/// `text.slice(0, units)`: whole characters up to the UTF-16 bound. The TypeScript can cut a
/// surrogate pair in half and keep a lone surrogate; a Rust string cannot, so the half is
/// dropped.
/// `text.slice(0, units)` over UTF-16 units, keeping whole characters.
pub fn truncate_utf16(text: &str, units: usize) -> String {
    let mut kept = String::new();
    let mut used = 0;
    for character in text.chars() {
        let width = character.len_utf16();
        if used + width > units {
            break;
        }
        used += width;
        kept.push(character);
    }
    kept
}

pub mod link;
pub mod pin;

pub use link::{
    LinkRefusal, PairingLink, RedeemRequest, RelayLink, parse_pairing_link, redeem_request,
};
pub use pin::{
    HANDSHAKE_TIMEOUT_MS, PIN_REJECTED_CLOSE, PinRefusal, PresentedCertificate, pin_rejected_close,
    pin_verdict, ticket_socket_origin, valid_fingerprint,
};

/// A Tailscale MagicDNS name (`mac.tailnet.ts.net`), whose certificate only that machine can get.
pub fn tailnet_name(host: Option<&str>) -> Option<String> {
    let name = host?.to_lowercase();
    let name = name.strip_suffix('.').unwrap_or(&name);
    if name.is_empty() || is_ip(name) || !name.ends_with(".ts.net") {
        return None;
    }
    Some(name.to_owned())
}

/// `net.isIP(name) !== 0`.
fn is_ip(name: &str) -> bool {
    name.parse::<std::net::IpAddr>().is_ok()
}

/// A request's target, after the rules that keep credentials out of URLs and cleartext off the
/// network (`client-access.ts:154`–`:163`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessTarget {
    /// The absolute URL with the path joined, as `new URL(path, origin)`.
    pub url: String,
    /// Whether the request is HTTPS and therefore pinned.
    pub tls: bool,
}

pub fn access_target(
    origin: &str,
    path: &str,
    fingerprint: Option<&str>,
) -> Result<AccessTarget, ClientError> {
    let base = Url::parse(origin)
        .map_err(|_| ClientError::new("offline", "Access transport unavailable"))?;
    let url = base
        .join(path)
        .map_err(|_| ClientError::new("offline", "Access transport unavailable"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ClientError::new(
            "auth",
            "Credentials must not be placed in request URLs",
        ));
    }
    let tls = url.scheme() == "https";
    let loopback = url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    if !tls && !loopback {
        return Err(ClientError::new(
            "auth",
            "Remote requests require pinned HTTPS",
        ));
    }
    if tls && fingerprint.is_none() {
        return Err(ClientError::new(
            "auth",
            "Remote requests require a public-key fingerprint",
        ));
    }
    if let Some(fingerprint) = fingerprint
        && !valid_fingerprint(fingerprint)
    {
        return Err(PinRefusal::InvalidFingerprint.client_error());
    }
    Ok(AccessTarget {
        url: url.to_string(),
        tls,
    })
}

/// The request deadline: the caller's, never more than 10 s and never less than 1 ms
/// (`client-access.ts:209`).
pub fn request_timeout_ms(caller: Option<i64>) -> i64 {
    caller.unwrap_or(10_000).clamp(1, 10_000)
}

/// The response too large to keep.
pub fn response_too_large() -> ClientError {
    ClientError::new("limit", "Response too large")
}

/// A response body that isn't JSON.
pub fn invalid_json_response() -> ClientError {
    ClientError::new("protocol", "Invalid JSON response")
}

/// Any other transport failure.
pub fn transport_unavailable() -> ClientError {
    ClientError::new("offline", "Access transport unavailable")
}

#[cfg(test)]
mod tests {
    //! The access request's rules and the failure text a person sees, as `client-access.ts`
    //! builds them.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{
        ACCESS_DETAIL_UTF16, ClientError, access_failure, access_target, request_timeout_ms,
        tailnet_name, truncate_utf16,
    };

    const PIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn a_request_keeps_credentials_out_of_urls_and_cleartext_off_the_network() {
        assert_eq!(
            access_target("https://host:4243", "/v1/tickets", Some(PIN))
                .unwrap()
                .url,
            "https://host:4243/v1/tickets"
        );
        assert!(
            access_target("http://127.0.0.1:4243", "/v1/status", None)
                .unwrap()
                .url
                .starts_with("http://127.0.0.1:4243")
        );
        assert_eq!(
            access_target("https://host", "/v1/x?token=1", Some(PIN))
                .unwrap_err()
                .message,
            "Credentials must not be placed in request URLs"
        );
        assert_eq!(
            access_target("https://owner:secret@host", "/v1/x", Some(PIN))
                .unwrap_err()
                .message,
            "Credentials must not be placed in request URLs"
        );
        assert_eq!(
            access_target("http://remote.example", "/v1/x", None)
                .unwrap_err()
                .message,
            "Remote requests require pinned HTTPS"
        );
        assert_eq!(
            access_target("https://host", "/v1/x", None)
                .unwrap_err()
                .message,
            "Remote requests require a public-key fingerprint"
        );
        assert_eq!(
            access_target("https://host", "/v1/x", Some("not-a-pin"))
                .unwrap_err()
                .message,
            "Invalid public-key fingerprint"
        );
    }

    #[test]
    fn a_refusal_keeps_the_daemons_own_words_up_to_the_detail_cap() {
        assert_eq!(
            access_failure(401, "{\"error\":\"Device token required\"}"),
            ClientError::new("auth", "HTTP 401: Device token required")
        );
        assert_eq!(
            access_failure(403, "{\"error\":\"You can't grant Accounts\"}").message,
            "HTTP 403: You can't grant Accounts"
        );
        // 429 and 5xx are offline: the client asks the person to retry, not to re-pair.
        assert_eq!(access_failure(429, "not json").code, "offline");
        assert_eq!(access_failure(500, "").code, "offline");
        assert_eq!(access_failure(400, "{\"error\":\"\"}").code, "daemon");
        // A detail is cut at 512 UTF-16 units: 256 emoji, not 128.
        let detail = format!("{{\"error\":\"{}\"}}", "😀".repeat(300));
        let failure = access_failure(401, &detail);
        let kept = failure.message.strip_prefix("HTTP 401: ").unwrap();
        assert_eq!(kept.encode_utf16().count(), ACCESS_DETAIL_UTF16);
        assert_eq!(kept.chars().count(), 256);
        assert_eq!(truncate_utf16("a😀", 2), "a");
    }

    #[test]
    fn the_request_deadline_is_the_callers_never_over_ten_seconds() {
        assert_eq!(request_timeout_ms(None), 10_000);
        assert_eq!(request_timeout_ms(Some(0)), 1);
        assert_eq!(request_timeout_ms(Some(2_500)), 2_500);
        assert_eq!(request_timeout_ms(Some(60_000)), 10_000);
    }

    #[test]
    fn a_tailnet_name_is_a_dns_name_ending_in_ts_net() {
        assert_eq!(
            tailnet_name(Some("Mac.Tailnet.ts.net.")).as_deref(),
            Some("mac.tailnet.ts.net")
        );
        assert_eq!(tailnet_name(Some("192.168.1.4")), None);
        assert_eq!(tailnet_name(Some("::1")), None);
        assert_eq!(tailnet_name(Some("example.com")), None);
        assert_eq!(tailnet_name(None), None);
    }
}
