// SPDX-License-Identifier: Apache-2.0
//! The URL a pairing link is (`@ace/client`'s `pairing-link.ts:102`): the code and fingerprint
//! travel in the fragment, which no HTTP request carries.

use crate::devices::Scope;

use super::PairingConnection;

/// The link a person opens to pair (`pairing-link.ts:102`). Code and fingerprint travel in the
/// URL fragment, which no HTTP request carries.
pub fn pairing_link_url(
    connection: &PairingConnection,
    code: &str,
    scopes: &[Scope],
    app: Option<&str>,
) -> String {
    let names: Vec<&str> = scopes.iter().map(|scope| scope.as_str()).collect();
    let scopes = names.join(",");
    match connection {
        PairingConnection::Relay(relay) => {
            let base = app.unwrap_or("https://app.acehq.dev");
            format!(
                "{}/pair#{}",
                origin(base),
                form(&[
                    ("relay", relay.url.as_str()),
                    ("hostId", relay.host_id.as_str()),
                    ("code", code),
                    ("scopes", &scopes),
                ])
            )
        }
        PairingConnection::Direct {
            origin: daemon,
            fingerprint,
            also_relay,
        } => {
            let daemon = origin(daemon);
            let base = match app {
                Some(app) => origin(app),
                None => daemon.clone(),
            };
            let mut fields: Vec<(&str, &str)> = Vec::new();
            let host;
            if app.is_some() {
                host = daemon.clone();
                fields.push(("host", host.as_str()));
            }
            fields.push(("fingerprint", fingerprint.as_str()));
            fields.push(("code", code));
            fields.push(("scopes", scopes.as_str()));
            if let Some(relay) = also_relay {
                fields.push(("viaRelay", relay.url.as_str()));
                fields.push(("viaRelayHostId", relay.host_id.as_str()));
            }
            format!("{base}/pair#{}", form(&fields))
        }
    }
}

/// A URL's origin (`new URL(value).origin`): scheme, host and port, without a path.
fn origin(value: &str) -> String {
    let (scheme, rest) = value.split_once("://").unwrap_or(("https", value));
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .trim_end_matches('/');
    format!("{scheme}://{authority}")
}

/// `URLSearchParams.toString()`: application/x-www-form-urlencoded, spaces as `+`.
fn form(fields: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (index, (key, value)) in fields.iter().enumerate() {
        if index > 0 {
            out.push('&');
        }
        percent(key, &mut out);
        out.push('=');
        percent(value, &mut out);
    }
    out
}

fn percent(value: &str, out: &mut String) {
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            other => {
                out.push('%');
                out.push_str(&format!("{other:02X}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/client/src/pairing-link.test.ts`'s link generation (its parsing half is
    //! the client's).

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::pairing_link_url;
    use crate::devices::Scope;
    use crate::pairing::{PairingConnection, RelayRoute};

    const PIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DAEMON: &str = "https://studio.tail1234.ts.net:4243";

    #[test]
    fn a_link_on_the_daemons_own_web_app_pairs_with_that_daemon() {
        let url = pairing_link_url(
            &PairingConnection::Direct {
                origin: DAEMON.to_owned(),
                fingerprint: PIN.to_owned(),
                also_relay: None,
            },
            "c0de",
            &[Scope::Read],
            None,
        );
        assert_eq!(
            url,
            format!("{DAEMON}/pair#fingerprint={PIN}&code=c0de&scopes=read")
        );
    }

    #[test]
    fn a_link_on_the_hosted_web_app_opens_there_and_still_names_the_daemon() {
        let url = pairing_link_url(
            &PairingConnection::Direct {
                origin: format!("{DAEMON}/"),
                fingerprint: PIN.to_owned(),
                also_relay: None,
            },
            "c0de",
            &[Scope::Read, Scope::Operate],
            Some("https://app.acehq.dev"),
        );
        assert_eq!(
            url,
            format!(
                "https://app.acehq.dev/pair#host=https%3A%2F%2Fstudio.tail1234.ts.net%3A4243\
                 &fingerprint={PIN}&code=c0de&scopes=read%2Coperate"
            )
        );
    }

    #[test]
    fn a_relay_link_opens_the_web_app_and_names_the_relay_and_host_key() {
        let host_id = "A".repeat(52);
        let url = pairing_link_url(
            &PairingConnection::Relay(RelayRoute {
                url: "wss://relay.example.com/".to_owned(),
                host_id: host_id.clone(),
            }),
            "c0de",
            &[Scope::Read],
            Some("https://app.acehq.dev"),
        );
        assert_eq!(
            url,
            format!(
                "https://app.acehq.dev/pair#relay=wss%3A%2F%2Frelay.example.com%2F\
                 &hostId={host_id}&code=c0de&scopes=read"
            )
        );
    }

    #[test]
    fn a_direct_link_can_also_name_the_persons_own_relay_as_a_second_way_in() {
        let host_id = "A".repeat(52);
        let url = pairing_link_url(
            &PairingConnection::Direct {
                origin: "https://192.168.1.4:7443/".to_owned(),
                fingerprint: PIN.to_owned(),
                also_relay: Some(RelayRoute {
                    url: "wss://relay.example.com/".to_owned(),
                    host_id: host_id.clone(),
                }),
            },
            "c0de",
            &[Scope::Read, Scope::Operate],
            None,
        );
        assert_eq!(
            url,
            format!(
                "https://192.168.1.4:7443/pair#fingerprint={PIN}&code=c0de\
                 &scopes=read%2Coperate&viaRelay=wss%3A%2F%2Frelay.example.com%2F\
                 &viaRelayHostId={host_id}"
            )
        );
    }
}
