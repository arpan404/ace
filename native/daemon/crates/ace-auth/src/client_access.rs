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
/// How long a pinned handshake may take (`client-access.ts:118`).
pub const HANDSHAKE_TIMEOUT_MS: i64 = 10_000;
/// The pinned socket transport closes with this code when a pin rejects (`client-access.ts:279`).
pub const PIN_REJECTED_CLOSE: u16 = 4001;

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

/// The pin a connector accepts: 64 lowercase hex characters, never a hostname.
pub fn valid_fingerprint(fingerprint: &str) -> bool {
    fingerprint.len() == 64
        && fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// What a pinned handshake found on the certificate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresentedCertificate {
    /// SHA-256 of the certificate's `SubjectPublicKeyInfo`, lowercase hex.
    pub fingerprint: &'static str,
    /// `Date.parse(certificate.validFrom)`, in milliseconds.
    pub valid_from: i64,
    /// `Date.parse(certificate.validTo)`, in milliseconds.
    pub valid_to: i64,
}

/// Why a pinned handshake is refused, in the TypeScript's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinRefusal {
    /// The pin isn't a fingerprint at all.
    InvalidFingerprint,
    /// The certificate's key is not the pinned one, and its name is not a trusted ts.net name.
    Mismatch,
    /// The pinned certificate is outside its validity window.
    Expired,
    /// The response failed for another reason.
    Failed,
}

impl PinRefusal {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidFingerprint => "Invalid public-key fingerprint",
            Self::Mismatch => "TLS public-key fingerprint mismatch",
            Self::Expired => "TLS certificate expired or not yet valid",
            Self::Failed => "TLS pin failed",
        }
    }

    /// Every pin refusal is an `auth` failure on the client, except the invalid pin a caller
    /// hands in, which is thrown where it is passed.
    pub fn client_error(self) -> ClientError {
        ClientError::new("auth", self.message())
    }
}

/// The pin check (`client-access.ts:121`–`:137`): the pinned key authenticates ace's own
/// certificate; a ts.net host may instead present the publicly trusted certificate Tailscale
/// issues for that exact name (ADR 0097). The validity window is checked after the pin.
pub fn pin_verdict(
    pin: &str,
    certificate: PresentedCertificate,
    trusted_name: bool,
    now: i64,
) -> Result<(), PinRefusal> {
    if !valid_fingerprint(pin) {
        return Err(PinRefusal::InvalidFingerprint);
    }
    if certificate.fingerprint != pin && !trusted_name {
        return Err(PinRefusal::Mismatch);
    }
    if now < certificate.valid_from || now >= certificate.valid_to {
        return Err(PinRefusal::Expired);
    }
    Ok(())
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

/// A pairing link, read (`packages/client/src/pairing-link.ts:2`–`:31`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingLink {
    /// The daemon's HTTPS origin with a trailing slash; empty for a relay link.
    pub daemon: String,
    /// A link through a self-hosted relay: redeem it there, pinning `host_id`.
    pub relay: Option<RelayLink>,
    /// A direct link's second way in: the person's own relay the daemon is also on.
    pub also_relay: Option<RelayLink>,
    pub code: String,
    /// The daemon's public-key pin; empty when the link has none.
    pub fingerprint: String,
    pub scopes: Vec<String>,
}

/// A relay route named in a fragment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayLink {
    pub url: String,
    pub host_id: String,
}

/// Why a pairing link can't be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkRefusal {
    /// Not a `/pair` link on a web origin, or one carrying credentials.
    NotAPairingLink,
    /// A `relay` fragment that isn't a relay socket with a host key.
    NotARelay,
    /// A `host` fragment that isn't one origin.
    NotAnAddress,
}

impl LinkRefusal {
    pub fn message(self) -> &'static str {
        match self {
            Self::NotAPairingLink => "Use the complete pairing link from your host computer.",
            Self::NotARelay => "This pairing link doesn't name a valid relay.",
            Self::NotAnAddress => "This pairing link doesn't name a valid computer address.",
        }
    }
}

/// Read a pairing link. A link that opens the daemon's own web app is `https://host:port/pair#…`;
/// one that opens a separately served web app names the daemon in its fragment.
pub fn parse_pairing_link(text: &str) -> Result<PairingLink, LinkRefusal> {
    let url = Url::parse(text.trim()).map_err(|_| LinkRefusal::NotAPairingLink)?;
    let web = matches!(url.scheme(), "https" | "http");
    if !web
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.path() != "/pair"
    {
        return Err(LinkRefusal::NotAPairingLink);
    }
    let fragment = url.fragment().unwrap_or_default();
    let pairs: Vec<(String, String)> = url::form_urlencoded::parse(fragment.as_bytes())
        .into_owned()
        .collect();
    let field = |key: &str| {
        pairs
            .iter()
            .find(|(each, _)| each == key)
            .map(|(_, value)| value.clone())
    };
    if let Some(relay_url) = field("relay") {
        let host_id = field("hostId").unwrap_or_default();
        let relay = Url::parse(&relay_url).map_err(|_| LinkRefusal::NotARelay)?;
        if !matches!(relay.scheme(), "wss" | "ws")
            || !relay.username().is_empty()
            || relay.password().is_some()
            || relay.query().is_some()
            || relay.fragment().is_some()
            || !valid_host_id(&host_id)
        {
            return Err(LinkRefusal::NotARelay);
        }
        return Ok(PairingLink {
            daemon: String::new(),
            relay: Some(RelayLink {
                url: relay.to_string(),
                host_id: host_id.clone(),
            }),
            also_relay: None,
            code: field("code").unwrap_or_default(),
            fingerprint: host_id,
            scopes: scopes_of(field("scopes")),
        });
    }
    let daemon = match field("host") {
        None => url.clone(),
        Some(host) => Url::parse(&host).map_err(|_| LinkRefusal::NotAnAddress)?,
    };
    let daemon_is_web = matches!(daemon.scheme(), "https" | "http");
    if !daemon_is_web
        || !daemon.username().is_empty()
        || daemon.password().is_some()
        || (field("host").is_some()
            && daemon.as_str() != format!("{}/", daemon.origin().ascii_serialization()))
    {
        return Err(LinkRefusal::NotAnAddress);
    }
    Ok(PairingLink {
        daemon: format!("{}/", daemon.origin().ascii_serialization()),
        relay: None,
        also_relay: relay_of(field("viaRelay"), field("viaRelayHostId")),
        code: field("code").unwrap_or_default(),
        fingerprint: field("fingerprint").unwrap_or_default(),
        scopes: scopes_of(field("scopes")),
    })
}

fn scopes_of(field: Option<String>) -> Vec<String> {
    field
        .unwrap_or_default()
        .split(',')
        .filter(|scope| !scope.is_empty())
        .map(str::to_owned)
        .collect()
}

fn valid_host_id(host_id: &str) -> bool {
    host_id.len() == 52
        && host_id
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || (b'2'..=b'7').contains(&byte))
}

/// A relay route named in a fragment, or `None` when it isn't a valid one.
fn relay_of(address: Option<String>, host_id: Option<String>) -> Option<RelayLink> {
    let (address, host_id) = (address?, host_id?);
    let relay = Url::parse(&address).ok()?;
    if !matches!(relay.scheme(), "wss" | "ws")
        || !relay.username().is_empty()
        || relay.password().is_some()
        || relay.query().is_some()
        || relay.fragment().is_some()
        || !valid_host_id(&host_id)
    {
        return None;
    }
    Some(RelayLink {
        url: relay.to_string(),
        host_id,
    })
}

/// What `redeemPairing` posts (`client-access.ts:227`–`:249`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedeemRequest {
    /// The daemon's origin, where `/v1/pair` is posted.
    pub origin: String,
    pub fingerprint: String,
    pub code: String,
    pub name: String,
    pub install_id: Option<String>,
    /// The raw P-256 public key the device proves the person's standing with (ADR 0190).
    pub standing_key: Option<String>,
}

pub fn redeem_request(
    link_text: &str,
    name: &str,
    install_id: Option<&str>,
    standing_key: Option<&str>,
) -> Result<RedeemRequest, ClientError> {
    let link = parse_pairing_link(link_text)
        .map_err(|refusal| ClientError::new("protocol", refusal.message()))?;
    if !link.daemon.starts_with("https:") {
        return Err(ClientError::new(
            "protocol",
            "Pairing requires an HTTPS URL with credentials in its fragment",
        ));
    }
    let origin = link.daemon.trim_end_matches('/').to_owned();
    Ok(RedeemRequest {
        origin,
        fingerprint: link.fingerprint,
        code: link.code,
        name: name.to_owned(),
        install_id: install_id.map(str::to_owned),
        standing_key: standing_key.map(str::to_owned),
    })
}

/// A ticket socket's origin: a pinned WSS origin with nothing else in it (`client-access.ts:254`).
pub fn ticket_socket_origin(origin: &str, fingerprint: &str) -> Result<String, ClientError> {
    let url = Url::parse(origin).map_err(|_| {
        ClientError::new(
            "auth",
            "Socket requires a pinned WSS origin without credentials",
        )
    })?;
    if url.scheme() != "wss"
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ClientError::new(
            "auth",
            "Socket requires a pinned WSS origin without credentials",
        ));
    }
    if !valid_fingerprint(fingerprint) {
        return Err(PinRefusal::InvalidFingerprint.client_error());
    }
    Ok(url.origin().ascii_serialization())
}

/// The code a pinned socket closes with when the pin rejects (`pinnedSocketTransport`).
pub fn pin_rejected_close(error: &ClientError) -> Option<u16> {
    (error.code == "auth").then_some(PIN_REJECTED_CLOSE)
}

#[cfg(test)]
mod tests {
    //! Ports `packages/client/src/pairing-link.test.ts`'s parsing half and the refusals
    //! `client-access.ts` owns. That module's handshake test is Windows-only
    //! (`tls-identity-node.process.test.ts`) and drives a real socket; the fingerprint check it
    //! exercises is ported here as a pure verdict, and the verifier itself in `ace-transport`.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{
        ACCESS_DETAIL_UTF16, ClientError, LinkRefusal, PinRefusal, PresentedCertificate,
        access_failure, access_target, parse_pairing_link, pin_verdict, redeem_request,
        request_timeout_ms, tailnet_name, ticket_socket_origin, truncate_utf16,
    };

    const PIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DAEMON: &str = "https://studio.tail1234.ts.net:4243";

    #[test]
    fn a_link_on_the_daemons_own_web_app_pairs_with_that_daemon() {
        let link = parse_pairing_link(&format!(
            "{DAEMON}/pair#fingerprint={PIN}&code=c0de&scopes=read"
        ))
        .unwrap();
        assert_eq!(link.daemon, format!("{DAEMON}/"));
        assert_eq!(link.code, "c0de");
        assert_eq!(link.fingerprint, PIN);
        assert_eq!(link.scopes, vec!["read"]);
        assert!(link.relay.is_none() && link.also_relay.is_none());
    }

    #[test]
    fn a_link_on_the_hosted_web_app_names_the_daemon_it_pairs_with() {
        let host = url::form_urlencoded::byte_serialize(DAEMON.as_bytes()).collect::<String>();
        let link = parse_pairing_link(&format!(
            "https://app.acehq.dev/pair#host={host}&fingerprint={PIN}&code=c0de&scopes=read%2Coperate"
        ))
        .unwrap();
        assert_eq!(link.daemon, format!("{DAEMON}/"));
        assert_eq!(link.scopes, vec!["read", "operate"]);
    }

    #[test]
    fn links_that_put_credentials_in_the_request_or_name_a_decorated_computer_are_refused() {
        let host = |value: &str| {
            url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
        };
        for link in [
            format!("{DAEMON}/pair?code=c0de"),
            format!("{DAEMON}/connect#code=c0de"),
            "https://user:secret@studio.tail1234.ts.net/pair#code=c0de".to_owned(),
            "ace://pair#code=c0de".to_owned(),
            format!(
                "https://app.acehq.dev/pair#host={}&code=c0de",
                host(&format!("{DAEMON}/v1"))
            ),
            format!(
                "https://app.acehq.dev/pair#host={}&code=c0de",
                host("https://u:p@studio.tail1234.ts.net")
            ),
            format!(
                "https://app.acehq.dev/pair#host={}&code=c0de",
                host("ftp://studio.tail1234.ts.net")
            ),
        ] {
            let refusal = parse_pairing_link(&link).unwrap_err();
            assert!(
                matches!(
                    refusal,
                    LinkRefusal::NotAPairingLink | LinkRefusal::NotAnAddress
                ),
                "{link}: {refusal:?}"
            );
        }
    }

    #[test]
    fn a_relay_link_names_the_relay_and_host_key_and_a_bad_one_is_refused() {
        let host_id = "A".repeat(52);
        let relay = url::form_urlencoded::byte_serialize("wss://relay.example.com/".as_bytes())
            .collect::<String>();
        let link = parse_pairing_link(&format!(
            "https://app.acehq.dev/pair#relay={relay}&hostId={host_id}&code=c0de&scopes=read"
        ))
        .unwrap();
        assert_eq!(link.daemon, "");
        assert_eq!(
            link.relay,
            Some(super::RelayLink {
                url: "wss://relay.example.com/".to_owned(),
                host_id: host_id.clone(),
            })
        );
        assert_eq!(link.fingerprint, host_id);
        for fragment in [
            format!(
                "relay={}&hostId={host_id}&code=c",
                url::form_urlencoded::byte_serialize("https://relay.example.com/".as_bytes())
                    .collect::<String>()
            ),
            format!(
                "relay={}&hostId={host_id}&code=c",
                url::form_urlencoded::byte_serialize("wss://relay.example.com/?token=1".as_bytes())
                    .collect::<String>()
            ),
            format!(
                "relay={}&hostId=short&code=c",
                url::form_urlencoded::byte_serialize("wss://relay.example.com/".as_bytes())
                    .collect::<String>()
            ),
        ] {
            assert_eq!(
                parse_pairing_link(&format!("https://app.acehq.dev/pair#{fragment}")).unwrap_err(),
                LinkRefusal::NotARelay
            );
        }
    }

    #[test]
    fn a_direct_link_can_also_name_the_persons_own_relay_and_a_malformed_one_is_dropped() {
        let host_id = "A".repeat(52);
        let relay = url::form_urlencoded::byte_serialize("wss://relay.example.com/".as_bytes())
            .collect::<String>();
        let link = parse_pairing_link(&format!(
            "https://192.168.1.4:7443/pair#fingerprint={PIN}&code=c0de&viaRelay={relay}\
             &viaRelayHostId={host_id}"
        ))
        .unwrap();
        assert_eq!(link.daemon, "https://192.168.1.4:7443/");
        assert_eq!(link.also_relay.unwrap().host_id, host_id);
        let broken = parse_pairing_link(&format!(
            "https://192.168.1.4:7443/pair#fingerprint={PIN}&code=c0de&viaRelay={relay}\
             &viaRelayHostId=nope"
        ))
        .unwrap();
        assert!(broken.also_relay.is_none());
        assert_eq!(broken.daemon, "https://192.168.1.4:7443/");
    }

    #[test]
    fn redeeming_needs_an_https_direct_link_and_posts_the_fields_it_names() {
        let request = redeem_request(
            &format!("{DAEMON}/pair#fingerprint={PIN}&code=c0de"),
            "Phone",
            Some("install-0001"),
            None,
        )
        .unwrap();
        assert_eq!(request.origin, DAEMON);
        assert_eq!(request.fingerprint, PIN);
        assert_eq!(request.code, "c0de");
        assert_eq!(request.name, "Phone");
        assert_eq!(request.install_id.as_deref(), Some("install-0001"));
        assert!(request.standing_key.is_none());
        // A relay link has no daemon address of its own to post to.
        let relay = url::form_urlencoded::byte_serialize("wss://relay.example.com/".as_bytes())
            .collect::<String>();
        let error = redeem_request(
            &format!(
                "https://app.acehq.dev/pair#relay={relay}&hostId={}&code=c0de",
                "A".repeat(52)
            ),
            "Phone",
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(
            error.message,
            "Pairing requires an HTTPS URL with credentials in its fragment"
        );
    }

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

    #[test]
    fn a_pinned_certificate_must_match_and_be_inside_its_validity() {
        let certificate = PresentedCertificate {
            fingerprint: PIN,
            valid_from: 1_000,
            valid_to: 2_000,
        };
        assert_eq!(pin_verdict(PIN, certificate, false, 1_500), Ok(()));
        assert_eq!(
            pin_verdict(PIN, certificate, false, 2_000),
            Err(PinRefusal::Expired)
        );
        assert_eq!(
            pin_verdict(PIN, certificate, false, 999),
            Err(PinRefusal::Expired)
        );
        assert_eq!(
            pin_verdict(&"b".repeat(64), certificate, false, 1_500),
            Err(PinRefusal::Mismatch)
        );
        // A ts.net name may instead present Tailscale's publicly trusted certificate.
        assert_eq!(
            pin_verdict(&"b".repeat(64), certificate, true, 1_500),
            Ok(())
        );
        assert_eq!(
            pin_verdict("nope", certificate, true, 1_500),
            Err(PinRefusal::InvalidFingerprint)
        );
        assert_eq!(
            PinRefusal::Mismatch.client_error(),
            ClientError::new("auth", "TLS public-key fingerprint mismatch")
        );
    }

    #[test]
    fn a_ticket_socket_needs_a_bare_pinned_wss_origin() {
        assert_eq!(
            ticket_socket_origin("wss://host:4243/", PIN).unwrap(),
            "wss://host:4243"
        );
        for origin in [
            "ws://host/",
            "wss://host/v1",
            "wss://host/?token=1",
            "wss://owner:secret@host/",
        ] {
            assert_eq!(
                ticket_socket_origin(origin, PIN).unwrap_err().message,
                "Socket requires a pinned WSS origin without credentials"
            );
        }
        assert_eq!(
            ticket_socket_origin("wss://host/", "nope")
                .unwrap_err()
                .message,
            "Invalid public-key fingerprint"
        );
    }
}
