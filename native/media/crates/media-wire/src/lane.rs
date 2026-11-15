// SPDX-License-Identifier: Apache-2.0
//! The lane hello (docs/media/plan.md, "Lane hello" and "K1 contract clarifications"): how the
//! daemon and ace-media prove to each other that they hold the lane secret before a lane
//! carries anything, without the secret ever going on the wire.
//!
//! 1. The daemon sends [`HELLO_LEN`] bytes: [`MAGIC`], the lane tag, and a fresh 32-byte nonce.
//! 2. ace-media answers [`SERVER_REPLY_LEN`] bytes: its proof (HMAC-SHA256 keyed by the secret
//!    over [`server_message`]), then a fresh nonce of its own.
//! 3. Only once that proof checks out does the daemon send its proof (over [`client_message`],
//!    which covers both nonces).
//! 4. ace-media checks it and answers [`ACCEPTED`]; from then on the lane carries its frames.
//!
//! A server that doesn't hold the secret learns a nonce and nothing else; a proof from another
//! connection or for the other direction fails, as the labels and nonces differ. This module is
//! the layout only: the MAC is each side's own (ring in ace-media, node:crypto in the daemon),
//! checked against the shared vectors in `vectors/lane/proofs.json`.

pub const MAGIC: &[u8; 4] = b"ACEL";
pub const NONCE_LEN: usize = 32;
pub const PROOF_LEN: usize = 32;
/// Magic, tag, the daemon's nonce.
pub const HELLO_LEN: usize = 4 + 1 + NONCE_LEN;
/// ace-media's proof, then its nonce.
pub const SERVER_REPLY_LEN: usize = PROOF_LEN + NONCE_LEN;
pub const ACCEPTED: u8 = 0x01;
pub const TAG_PRIORITY: u8 = 1;
pub const TAG_EGRESS: u8 = 2;
pub const SERVER_LABEL: &[u8] = b"ace-media lane v1 server";
pub const CLIENT_LABEL: &[u8] = b"ace-media lane v1 client";

/// What ace-media's proof is a MAC of.
pub fn server_message(tag: u8, client_nonce: &[u8; NONCE_LEN]) -> Vec<u8> {
    let mut message = Vec::with_capacity(SERVER_LABEL.len() + 1 + NONCE_LEN);
    message.extend_from_slice(SERVER_LABEL);
    message.push(tag);
    message.extend_from_slice(client_nonce);
    message
}

/// What the daemon's proof is a MAC of: both nonces, so it can't be replayed to another
/// connection.
pub fn client_message(
    tag: u8,
    client_nonce: &[u8; NONCE_LEN],
    server_nonce: &[u8; NONCE_LEN],
) -> Vec<u8> {
    let mut message = Vec::with_capacity(CLIENT_LABEL.len() + 1 + 2 * NONCE_LEN);
    message.extend_from_slice(CLIENT_LABEL);
    message.push(tag);
    message.extend_from_slice(client_nonce);
    message.extend_from_slice(server_nonce);
    message
}

/// The whole handshake, bound into the lane's record keys: magic, tag, both nonces, then
/// ace-media's proof and the daemon's.
pub fn transcript(
    tag: u8,
    client_nonce: &[u8; NONCE_LEN],
    server_nonce: &[u8; NONCE_LEN],
    server_proof: &[u8; PROOF_LEN],
    client_proof: &[u8; PROOF_LEN],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(HELLO_LEN + NONCE_LEN + 2 * PROOF_LEN);
    out.extend_from_slice(MAGIC);
    out.push(tag);
    out.extend_from_slice(client_nonce);
    out.extend_from_slice(server_nonce);
    out.extend_from_slice(server_proof);
    out.extend_from_slice(client_proof);
    out
}

/// The daemon's hello: `None` for an unknown tag.
pub fn hello(tag: u8, client_nonce: &[u8; NONCE_LEN]) -> Option<[u8; HELLO_LEN]> {
    if tag != TAG_PRIORITY && tag != TAG_EGRESS {
        return None;
    }
    let mut hello = [0u8; HELLO_LEN];
    hello[..4].copy_from_slice(MAGIC);
    hello[4] = tag;
    hello[5..].copy_from_slice(client_nonce);
    Some(hello)
}

/// A hello's tag and nonce: `None` unless it is exactly one with the magic and a known tag.
pub fn parse_hello(bytes: &[u8]) -> Option<(u8, [u8; NONCE_LEN])> {
    if bytes.len() != HELLO_LEN || &bytes[..4] != MAGIC {
        return None;
    }
    let tag = bytes[4];
    if tag != TAG_PRIORITY && tag != TAG_EGRESS {
        return None;
    }
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&bytes[5..]);
    Some((tag, nonce))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    fn bytes(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    fn nonce(text: &str) -> [u8; NONCE_LEN] {
        bytes(text).try_into().unwrap()
    }

    #[test]
    fn the_messages_are_the_shared_vectors() {
        let doc: serde_json::Value =
            serde_json::from_str(include_str!("../../../vectors/lane/proofs.json")).unwrap();
        assert_eq!(
            doc["serverLabel"].as_str().unwrap().as_bytes(),
            SERVER_LABEL
        );
        assert_eq!(
            doc["clientLabel"].as_str().unwrap().as_bytes(),
            CLIENT_LABEL
        );
        let client = nonce(doc["clientNonce"].as_str().unwrap());
        let server = nonce(doc["serverNonce"].as_str().unwrap());
        for case in doc["cases"].as_array().unwrap() {
            let tag = u8::try_from(case["tag"].as_u64().unwrap()).unwrap();
            assert_eq!(
                server_message(tag, &client),
                bytes(case["serverMessage"].as_str().unwrap())
            );
            assert_eq!(
                client_message(tag, &client, &server),
                bytes(case["clientMessage"].as_str().unwrap())
            );
            let proof = |key: &str| -> [u8; PROOF_LEN] {
                bytes(case[key].as_str().unwrap()).try_into().unwrap()
            };
            assert_eq!(
                transcript(
                    tag,
                    &client,
                    &server,
                    &proof("serverProof"),
                    &proof("clientProof")
                ),
                bytes(case["transcript"].as_str().unwrap())
            );
        }
    }

    #[test]
    fn a_hello_is_exactly_the_magic_a_known_tag_and_a_nonce() {
        let nonce = [7u8; NONCE_LEN];
        let good = hello(TAG_EGRESS, &nonce).unwrap();
        assert_eq!(parse_hello(&good), Some((TAG_EGRESS, nonce)));
        assert_eq!(hello(3, &nonce), None);
        let mut wrong_magic = good;
        wrong_magic[0] = b'X';
        let mut tag_zero = good;
        tag_zero[4] = 0;
        for bad in [&wrong_magic[..], &tag_zero[..], &good[..HELLO_LEN - 1]] {
            assert_eq!(parse_hello(bad), None);
        }
        let mut long = good.to_vec();
        long.push(0);
        assert_eq!(parse_hello(&long), None);
    }
}
