// SPDX-License-Identifier: Apache-2.0
//! A pairing link read as the client reads it (`packages/client/src/pairing-link.ts:31`) and the
//! redemption request `client-access.ts` makes from one.

use url::Url;

use super::ClientError;

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

#[cfg(test)]
mod tests {
    //! Ports `packages/client/src/pairing-link.test.ts`'s parsing half and the redemption fields.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{LinkRefusal, parse_pairing_link, redeem_request};

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
}
