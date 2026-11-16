// SPDX-License-Identifier: Apache-2.0
//! The WebSocket client side of a relay stream (RFC 6455), only as much as a relay stream needs:
//! the upgrade, unfragmented binary frames each way, pings answered, a close. Written by hand so
//! a sealed frame goes from its pooled buffer to the socket with no copy or allocation: the
//! header is built on the stack and the payload is masked in place. Pure; the shell does I/O.

/// The relay's frame limit (`apps/relay` `FRAME_LIMIT`).
pub const MAX_PAYLOAD: usize = 65_535;
/// The longest upgrade response read.
pub const MAX_RESPONSE: usize = 8 * 1024;

pub const OP_BINARY: u8 = 2;
pub const OP_CLOSE: u8 = 8;
pub const OP_PING: u8 = 9;
pub const OP_PONG: u8 = 10;

/// A `ws://` or `wss://host[:port]/path?query` address, split for dialing.
#[derive(Debug, PartialEq, Eq)]
pub struct Address {
    /// `host:port`, for the TCP connect.
    pub authority: String,
    /// The `Host` header.
    pub host: String,
    pub target: String,
    /// `wss://`: the name the relay's certificate must carry (and the SNI), without its port or
    /// an IPv6 address's brackets.
    pub tls: Option<String>,
}

pub fn address(url: &str) -> Option<Address> {
    let (rest, tls, port) = match url.strip_prefix("wss://") {
        Some(rest) => (rest, true, 443),
        None => (url.strip_prefix("ws://")?, false, 80),
    };
    let (authority, target) = match rest.find(['/', '?']) {
        Some(i) if rest.as_bytes()[i] == b'/' => (&rest[..i], rest[i..].to_owned()),
        Some(i) => (&rest[..i], format!("/{}", &rest[i..])),
        None => (rest, "/".to_owned()),
    };
    if authority.is_empty()
        || authority.contains('@')
        || target.contains(|c: char| c.is_ascii_control() || c == ' ' || c == '#')
    {
        return None;
    }
    let with_port = if authority
        .rsplit_once(':')
        .is_some_and(|(_, p)| p.parse::<u16>().is_ok())
    {
        authority.to_owned()
    } else {
        format!("{authority}:{port}")
    };
    let name = with_port
        .rsplit_once(':')
        .map(|(name, _)| name.trim_start_matches('[').trim_end_matches(']'))
        .filter(|name| !name.is_empty())?;
    Some(Address {
        tls: tls.then(|| name.to_owned()),
        authority: with_port,
        host: authority.to_owned(),
        target,
    })
}

/// The upgrade request, with `key` as `Sec-WebSocket-Key`.
pub fn request(address: &Address, key: &str) -> String {
    format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        address.target, address.host
    )
}

/// Where the upgrade response ends, once it has.
pub fn response_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
}

/// Whether `head` (the response up to its blank line) accepts the upgrade for `key`.
pub fn accepted(head: &[u8], key: &str) -> bool {
    let Ok(text) = std::str::from_utf8(head) else {
        return false;
    };
    let mut lines = text.split("\r\n");
    let status = lines.next().unwrap_or_default();
    if !status.starts_with("HTTP/1.1 101") {
        return false;
    }
    let expected = tungstenite::handshake::derive_accept_key(key.as_bytes());
    let mut accept = false;
    let mut upgrade = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("sec-websocket-accept") {
            accept = value == expected;
        } else if name.eq_ignore_ascii_case("upgrade") {
            upgrade = value.eq_ignore_ascii_case("websocket");
        }
    }
    accept && upgrade
}

/// A fresh `Sec-WebSocket-Key`.
pub fn key() -> String {
    tungstenite::handshake::client::generate_key()
}

/// A client frame's header (FIN, `opcode`, masked) for a payload of `length` bytes.
pub fn header(opcode: u8, length: usize, mask: [u8; 4]) -> ([u8; 14], usize) {
    let mut out = [0u8; 14];
    out[0] = 0x80 | opcode;
    let at = if length < 126 {
        out[1] = 0x80 | length as u8;
        2
    } else if length <= usize::from(u16::MAX) {
        out[1] = 0x80 | 126;
        out[2..4].copy_from_slice(&(length as u16).to_be_bytes());
        4
    } else {
        out[1] = 0x80 | 127;
        out[2..10].copy_from_slice(&(length as u64).to_be_bytes());
        10
    };
    out[at..at + 4].copy_from_slice(&mask);
    (out, at + 4)
}

/// Masks (or unmasks) a payload in place.
pub fn mask(payload: &mut [u8], key: [u8; 4]) {
    let word = u32::from_ne_bytes(key);
    let mut chunks = payload.chunks_exact_mut(4);
    for chunk in &mut chunks {
        let value = u32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) ^ word;
        chunk.copy_from_slice(&value.to_ne_bytes());
    }
    for (i, byte) in chunks.into_remainder().iter_mut().enumerate() {
        *byte ^= key[i];
    }
}

/// What the next whole server frame in `buffer` is, taken out of it: `Ok(None)` until one has
/// fully arrived; `Err` for a frame a relay never sends.
pub fn take_frame(buffer: &mut Vec<u8>) -> Result<Option<(u8, Vec<u8>)>, &'static str> {
    match parse(buffer) {
        Parse::Invalid => Err("protocol"),
        Parse::Frame(frame) if buffer.len() >= frame.header + frame.length => {
            let payload = buffer[frame.header..frame.header + frame.length].to_vec();
            buffer.drain(..frame.header + frame.length);
            Ok(Some((frame.opcode, payload)))
        }
        Parse::Frame(_) | Parse::Short => Ok(None),
    }
}

/// A server frame's header, read from its first bytes.
#[derive(Debug, PartialEq, Eq)]
pub struct Incoming {
    pub opcode: u8,
    /// The header's length; the payload follows it.
    pub header: usize,
    pub length: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parse {
    /// More bytes are needed for the header.
    Short,
    Frame(Incoming),
    /// Not a frame a relay sends: fragmented, masked, reserved bits, a text frame, too long.
    Invalid,
}

pub fn parse(bytes: &[u8]) -> Parse {
    let [first, second, ..] = *bytes else {
        return Parse::Short;
    };
    let opcode = first & 0x0f;
    if first & 0xf0 != 0x80 || second & 0x80 != 0 {
        return Parse::Invalid;
    }
    if !matches!(opcode, OP_BINARY | OP_CLOSE | OP_PING | OP_PONG) {
        return Parse::Invalid;
    }
    let (length, header) = match second & 0x7f {
        126 => match bytes.get(2..4) {
            Some(b) => (usize::from(u16::from_be_bytes([b[0], b[1]])), 4),
            None => return Parse::Short,
        },
        127 => match bytes.get(2..10) {
            Some(b) => {
                let mut eight = [0u8; 8];
                eight.copy_from_slice(b);
                match usize::try_from(u64::from_be_bytes(eight)) {
                    Ok(n) => (n, 10),
                    Err(_) => return Parse::Invalid,
                }
            }
            None => return Parse::Short,
        },
        n => (usize::from(n), 2),
    };
    // Control frames carry at most 125 bytes (RFC 6455 §5.5).
    if length > MAX_PAYLOAD || (opcode != OP_BINARY && length > 125) {
        return Parse::Invalid;
    }
    Parse::Frame(Incoming {
        opcode,
        header,
        length,
    })
}

/// Unpredictable frame masks (RFC 6455 §5.3), from a seed the platform's hasher randomized.
pub struct Masks(u64);

impl Masks {
    pub fn new() -> Self {
        use std::hash::{BuildHasher, Hasher};
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(0x5eed);
        Self(hasher.finish() | 1)
    }

    pub fn next(&mut self) -> [u8; 4] {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        let value = self.0.wrapping_mul(0x2545_f491_4f6c_dd1d);
        ((value >> 32) as u32).to_ne_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_join_address_splits_into_where_to_dial_and_what_to_ask() {
        assert_eq!(
            address("ws://127.0.0.1:8787/join?ticket=ab&hostId=X"),
            Some(Address {
                authority: "127.0.0.1:8787".into(),
                host: "127.0.0.1:8787".into(),
                target: "/join?ticket=ab&hostId=X".into(),
                tls: None,
            })
        );
        assert_eq!(
            address("ws://relay").map(|a| a.authority),
            Some("relay:80".into())
        );
        // A TLS relay is verified (and named in the SNI) by its host alone.
        let tls = address("wss://relay.example/join?ticket=t");
        assert_eq!(
            tls.as_ref().map(|a| a.authority.as_str()),
            Some("relay.example:443")
        );
        assert_eq!(tls.and_then(|a| a.tls), Some("relay.example".into()));
        assert_eq!(
            address("wss://[::1]:9443/join").and_then(|a| a.tls),
            Some("::1".into())
        );
        assert_eq!(address("http://relay/join"), None);
        assert_eq!(address("ws://user@relay/join"), None);
        assert_eq!(address("ws://relay/jo in"), None);
    }

    #[test]
    fn an_upgrade_is_accepted_only_with_the_key_derived_answer() {
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let good = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
        assert_eq!(response_end(good), Some(good.len()));
        assert!(accepted(good, key));
        assert!(!accepted(good, "AAAAAAAAAAAAAAAAAAAAAA=="));
        let refused = b"HTTP/1.1 429 Too Many Requests\r\n\r\n";
        assert!(!accepted(refused, key));
    }

    #[test]
    fn a_masked_frame_round_trips_and_sizes_pick_their_length_form() {
        for length in [0, 125, 126, 65_535] {
            let (head, n) = header(OP_BINARY, length, [1, 2, 3, 4]);
            assert_eq!(n, if length < 126 { 6 } else { 8 });
            assert_eq!(head[0], 0x82);
            assert_eq!(&head[n - 4..n], &[1, 2, 3, 4]);
        }
        let mut payload: Vec<u8> = (0..23).collect();
        mask(&mut payload, [9, 8, 7, 6]);
        assert_ne!(payload, (0..23).collect::<Vec<u8>>());
        mask(&mut payload, [9, 8, 7, 6]);
        assert_eq!(payload, (0..23).collect::<Vec<u8>>());
    }

    #[test]
    fn server_frames_parse_and_anything_a_relay_never_sends_is_refused() {
        assert_eq!(parse(&[0x82]), Parse::Short);
        assert_eq!(
            parse(&[0x82, 126, 0x01, 0x00]),
            Parse::Frame(Incoming {
                opcode: OP_BINARY,
                header: 4,
                length: 256
            })
        );
        assert_eq!(parse(&[0x82, 126, 0x01]), Parse::Short);
        // Masked from the server, fragmented, text, oversized, a long control frame.
        assert_eq!(parse(&[0x82, 0x81]), Parse::Invalid);
        assert_eq!(parse(&[0x02, 1]), Parse::Invalid);
        assert_eq!(parse(&[0x81, 1]), Parse::Invalid);
        assert_eq!(parse(&[0x82, 127, 0, 0, 0, 0, 0, 1, 0, 0]), Parse::Invalid);
        assert_eq!(parse(&[0x89, 126, 0, 200]), Parse::Invalid);
    }

    #[test]
    fn masks_differ_from_frame_to_frame() {
        let mut masks = Masks::new();
        let a = masks.next();
        let b = masks.next();
        assert_ne!(a, b);
    }
}
