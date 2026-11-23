// SPDX-License-Identifier: Apache-2.0
//! The hop's headers: the four reserved `x-ace-hop-*` fields, which no client
//! can set and the transport fills from the accepted socket and this boot's
//! secret, and the hop-by-hop fields neither direction forwards. Pure: it reads
//! the head's fields and the peer, and touches no socket.

use crate::error::TransportError;
use crate::head::connection_names;
use crate::peer::Peer;
use zeroize::Zeroize;

/// The hop's secret: 32 bytes the OS CSPRNG produced once per boot, sent hex.
pub const HOP_SECRET: &str = "x-ace-hop-secret";
/// The accepted socket's remote IP, in its usual form.
pub const HOP_PEER_ADDRESS: &str = "x-ace-hop-peer-address";
/// The accepted socket's remote port, decimal.
pub const HOP_PEER_PORT: &str = "x-ace-hop-peer-port";
/// The accepted socket's local port, decimal (the port the client connected to).
pub const HOP_LOCAL_PORT: &str = "x-ace-hop-local-port";

/// The four reserved fields, and the only ones the hop adds.
pub const RESERVED: [&str; 4] = [HOP_SECRET, HOP_PEER_ADDRESS, HOP_PEER_PORT, HOP_LOCAL_PORT];

/// RFC 9110 §7.6.1's hop-by-hop fields, beside the ones `Connection` names.
const HOP_BY_HOP: [&str; 7] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// The 32-byte secret every proxied request carries. It is generated from the
/// OS CSPRNG at the boundary ([`HopSecret::generate`]) or read back from the
/// binding's hex, and it has no `Debug`, `Display` or `Clone`: nothing formats
/// it but the header it belongs in.
pub struct HopSecret([u8; 32]);

impl HopSecret {
    /// 32 bytes from the OS CSPRNG. The only place the crate reads randomness.
    pub fn generate() -> Result<Self, TransportError> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|source| TransportError::SecretUnavailable { source })?;
        Ok(Self(bytes))
    }

    /// Read a secret the binding kept in memory as 64 hex characters.
    pub fn from_hex(hex: &str) -> Result<Self, TransportError> {
        let digits = hex.as_bytes();
        if digits.len() != 64 {
            return Err(TransportError::SecretEncoding);
        }
        let mut bytes = [0u8; 32];
        for (byte, pair) in bytes.iter_mut().zip(digits.chunks_exact(2)) {
            *byte = (nibble(pair[0])? << 4) | nibble(pair[1])?;
        }
        Ok(Self(bytes))
    }

    /// The header value: the 32 bytes as 64 lower-case hex characters.
    pub fn hex(&self) -> String {
        const DIGITS: [u8; 16] = *b"0123456789abcdef";
        let mut out = String::with_capacity(64);
        for byte in self.0 {
            out.push(char::from(DIGITS[usize::from(byte >> 4)]));
            out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
        }
        out
    }
}

impl Drop for HopSecret {
    fn drop(&mut self) {
        // A plain fill can be optimized away; zeroize writes through a barrier.
        self.0.zeroize();
    }
}

fn nibble(digit: u8) -> Result<u8, TransportError> {
    match digit {
        b'0'..=b'9' => Ok(digit - b'0'),
        b'a'..=b'f' => Ok(digit - b'a' + 10),
        b'A'..=b'F' => Ok(digit - b'A' + 10),
        _ => Err(TransportError::SecretEncoding),
    }
}

/// What the hop sends on: every field as sent except the reserved four (every
/// client-sent instance is dropped) and the hop-by-hop ones, then exactly one
/// value of each reserved field, from the secret and the accepted socket.
///
/// `Transfer-Encoding: chunked` is hop-by-hop but it is the body's only
/// framing: with no length and no `chunked`, hyper's client sends an empty body
/// for GET, HEAD and CONNECT (its `set_length`), which would lose a valid
/// chunked request's payload. So a chunked request keeps that one field, and
/// every other hop-by-hop field is still dropped.
pub fn request_headers(
    headers: &[(String, Vec<u8>)],
    secret: &HopSecret,
    peer: &Peer,
) -> Vec<(String, Vec<u8>)> {
    let mut out = forwarded(headers, true);
    out.push((HOP_SECRET.to_owned(), secret.hex().into_bytes()));
    out.push((
        HOP_PEER_ADDRESS.to_owned(),
        peer.remote.ip().to_string().into_bytes(),
    ));
    out.push((
        HOP_PEER_PORT.to_owned(),
        peer.remote.port().to_string().into_bytes(),
    ));
    out.push((
        HOP_LOCAL_PORT.to_owned(),
        peer.local.port().to_string().into_bytes(),
    ));
    out
}

/// What the hop sends back: every field as sent except the hop-by-hop ones.
/// The reserved four are dropped too, so a handler cannot echo the secret to a
/// client by copying its request's fields.
pub fn response_headers(headers: &[(String, Vec<u8>)]) -> Vec<(String, Vec<u8>)> {
    forwarded(headers, false)
}

fn forwarded(headers: &[(String, Vec<u8>)], request: bool) -> Vec<(String, Vec<u8>)> {
    let named = connection_names(headers);
    headers
        .iter()
        .filter(|(name, value)| {
            let lower = name.to_ascii_lowercase();
            if RESERVED.contains(&lower.as_str()) {
                return false;
            }
            if request && lower == "transfer-encoding" && chunked(value) {
                return true;
            }
            !HOP_BY_HOP.contains(&lower.as_str()) && !named.contains(&lower)
        })
        .cloned()
        .collect()
}

/// Whether a `Transfer-Encoding` value ends in `chunked`, which is the only
/// framing a request may leave out of a length but hyper's client keeps.
fn chunked(value: &[u8]) -> bool {
    let text = String::from_utf8_lossy(value);
    text.split(',')
        .next_back()
        .is_some_and(|last| last.trim().eq_ignore_ascii_case("chunked"))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::net::SocketAddr;

    fn pair(name: &str, value: &str) -> (String, Vec<u8>) {
        (name.to_owned(), value.as_bytes().to_vec())
    }

    /// A client's address and the port it connected to, as the accepted socket
    /// reports them.
    fn peer() -> Peer {
        Peer {
            remote: "127.0.0.1:51234"
                .parse::<SocketAddr>()
                .expect("a test address"),
            local: "127.0.0.1:7842"
                .parse::<SocketAddr>()
                .expect("a test address"),
        }
    }

    fn secret() -> HopSecret {
        HopSecret::from_hex(&"ab".repeat(32)).expect("64 hex characters")
    }

    fn value_of<'a>(headers: &'a [(String, Vec<u8>)], name: &str) -> Option<&'a [u8]> {
        headers
            .iter()
            .find(|(field, _)| field == name)
            .map(|(_, value)| value.as_slice())
    }

    #[test]
    fn a_client_sent_reserved_field_never_reaches_the_target() {
        let sent = vec![
            pair("x-ace-hop-secret", "client"),
            pair("X-Ace-Hop-Peer-Address", "10.0.0.9"),
            pair("x-ace-hop-peer-port", "1"),
            pair("x-ace-hop-local-port", "2"),
            pair("x-ace-sha256", "00ff"),
        ];
        let out = request_headers(&sent, &secret(), &peer());

        let expected_secret = "ab".repeat(32);
        assert_eq!(
            value_of(&out, HOP_SECRET),
            Some(expected_secret.as_bytes()),
            "the hop's secret replaces the client's value"
        );
        assert_eq!(
            value_of(&out, HOP_PEER_ADDRESS),
            Some(b"127.0.0.1".as_slice())
        );
        assert_eq!(value_of(&out, HOP_PEER_PORT), Some(b"51234".as_slice()));
        assert_eq!(value_of(&out, HOP_LOCAL_PORT), Some(b"7842".as_slice()));
        assert_eq!(value_of(&out, "x-ace-sha256"), Some(b"00ff".as_slice()));

        for name in RESERVED {
            assert_eq!(
                out.iter()
                    .filter(|(field, _)| field.eq_ignore_ascii_case(name))
                    .count(),
                1,
                "{name} appears exactly once"
            );
        }
    }

    #[test]
    fn hop_by_hop_fields_and_the_ones_connection_names_are_not_forwarded() {
        let sent = vec![
            pair("Connection", "keep-alive, x-dropped"),
            pair("Keep-Alive", "timeout=5"),
            pair("Proxy-Connection", "keep-alive"),
            pair("TE", "trailers"),
            pair("Trailer", "x-checksum"),
            pair("Upgrade", "websocket"),
            pair("X-Dropped", "yes"),
            pair("Host", "127.0.0.1:7842"),
            pair("Content-Type", "application/json"),
        ];
        let out = request_headers(&sent, &secret(), &peer());

        assert_eq!(value_of(&out, "Host"), Some(b"127.0.0.1:7842".as_slice()));
        assert_eq!(
            value_of(&out, "Content-Type"),
            Some(b"application/json".as_slice())
        );
        for name in [
            "Connection",
            "Keep-Alive",
            "Proxy-Connection",
            "TE",
            "Trailer",
            "Upgrade",
            "X-Dropped",
        ] {
            assert!(
                out.iter()
                    .all(|(field, _)| !field.eq_ignore_ascii_case(name)),
                "{name} is hop-by-hop"
            );
        }
    }

    #[test]
    fn a_chunked_request_keeps_the_one_field_that_frames_its_body() {
        let sent = vec![
            pair("Transfer-Encoding", "chunked"),
            pair("Content-Length", "5"),
            pair("Trailer", "x-checksum"),
        ];
        let out = request_headers(&sent, &secret(), &peer());
        assert_eq!(
            value_of(&out, "Transfer-Encoding"),
            Some(b"chunked".as_slice()),
            "a chunked body keeps its framing"
        );
        assert_eq!(value_of(&out, "Content-Length"), Some(b"5".as_slice()));
        assert!(
            out.iter()
                .all(|(field, _)| !field.eq_ignore_ascii_case("trailer")),
            "the other hop-by-hop fields still go"
        );

        let gzip = vec![pair("Transfer-Encoding", "gzip")];
        let out = request_headers(&gzip, &secret(), &peer());
        assert!(
            out.iter()
                .all(|(field, _)| !field.eq_ignore_ascii_case("transfer-encoding")),
            "only chunked framing is kept"
        );
    }

    #[test]
    fn the_response_direction_drops_hop_by_hop_and_reserved_fields_only() {
        let sent = vec![
            pair("Connection", "close, x-private"),
            pair("X-Private", "gone"),
            pair("Transfer-Encoding", "chunked"),
            pair("X-Ace-Hop-Secret", "leak"),
            pair("Content-Length", "3"),
            pair("Date", "Mon, 23 Nov 2026 00:00:00 GMT"),
        ];
        let out = response_headers(&sent);

        assert_eq!(value_of(&out, "Content-Length"), Some(b"3".as_slice()));
        assert_eq!(
            value_of(&out, "Date"),
            Some(b"Mon, 23 Nov 2026 00:00:00 GMT".as_slice())
        );
        for name in [
            "Connection",
            "X-Private",
            "Transfer-Encoding",
            "X-Ace-Hop-Secret",
        ] {
            assert!(
                out.iter()
                    .all(|(field, _)| !field.eq_ignore_ascii_case(name)),
                "{name} is not forwarded"
            );
        }
    }

    #[test]
    fn a_secret_is_thirty_two_bytes_from_hex_or_the_os() {
        let from_hex = HopSecret::from_hex(&"0f".repeat(32)).expect("64 hex characters");
        assert_eq!(from_hex.hex(), "0f".repeat(32));

        let generated = HopSecret::generate().expect("the OS CSPRNG answers");
        assert_eq!(generated.hex().len(), 64);
    }

    #[test]
    fn a_secret_that_is_not_sixty_four_hex_characters_is_refused() {
        for bad in [
            String::new(),
            "ab".repeat(31),
            "ab".repeat(33),
            "zz".repeat(32),
            "a".repeat(63),
        ] {
            assert!(
                matches!(
                    HopSecret::from_hex(&bad),
                    Err(TransportError::SecretEncoding)
                ),
                "{bad:?} is refused"
            );
        }
    }
}
