// SPDX-License-Identifier: Apache-2.0
//! Lane authentication, pure (the hello's layout is `media_wire::lane`). ace-media proves it
//! holds the lane secret first, with a MAC over the daemon's fresh nonce; the daemon then proves
//! it, with a MAC over both nonces. The secret never goes on the wire, a proof from another
//! connection or for the other direction fails, and each lane is accepted once.
use crate::secret::LaneSecret;
use media_wire::lane::{self, NONCE_LEN, PROOF_LEN, SERVER_REPLY_LEN};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

pub const LANE_ACCEPTED: u8 = lane::ACCEPTED;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SocketLane {
    Priority,
    Egress,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// The connection is this lane from now on.
    Accept(SocketLane),
    /// Close it without a word.
    Refuse,
}

/// One connection's handshake once its hello was well formed: the reply to send, and the proof
/// the daemon must answer with.
pub struct Challenge {
    lane: SocketLane,
    reply: [u8; SERVER_REPLY_LEN],
    expected: Zeroizing<[u8; PROOF_LEN]>,
}
impl Challenge {
    /// ace-media's proof, then its nonce.
    pub fn reply(&self) -> &[u8; SERVER_REPLY_LEN] {
        &self.reply
    }
}

/// The two lanes, each accepted once; the secret is dropped once both are up.
pub struct LaneAuth {
    secret: Option<LaneSecret>,
    priority: bool,
    egress: bool,
}

impl LaneAuth {
    pub fn new(secret: LaneSecret) -> Self {
        Self {
            secret: Some(secret),
            priority: false,
            egress: false,
        }
    }

    fn taken(&self, lane: SocketLane) -> bool {
        match lane {
            SocketLane::Priority => self.priority,
            SocketLane::Egress => self.egress,
        }
    }

    /// Answers a hello for a lane not yet taken with ace-media's proof and `server_nonce` (fresh
    /// from the OS for every connection). `None`: close the connection without a word.
    pub fn challenge(&self, hello: &[u8], server_nonce: [u8; NONCE_LEN]) -> Option<Challenge> {
        let secret = self.secret.as_ref()?;
        let (tag, client_nonce) = lane::parse_hello(hello)?;
        let lane = if tag == lane::TAG_PRIORITY {
            SocketLane::Priority
        } else {
            SocketLane::Egress
        };
        if self.taken(lane) {
            return None;
        }
        let mut reply = [0u8; SERVER_REPLY_LEN];
        reply[..PROOF_LEN]
            .copy_from_slice(&secret.mac(&lane::server_message(tag, &client_nonce))[..]);
        reply[PROOF_LEN..].copy_from_slice(&server_nonce);
        let expected = secret.mac(&lane::client_message(tag, &client_nonce, &server_nonce));
        Some(Challenge {
            lane,
            reply,
            expected,
        })
    }

    /// The daemon's proof for `challenge`, compared in constant time.
    pub fn accept(&mut self, challenge: &Challenge, proof: &[u8]) -> Verdict {
        let proven: bool = challenge.expected[..].ct_eq(proof).into();
        if !proven || self.secret.is_none() || self.taken(challenge.lane) {
            return Verdict::Refuse;
        }
        match challenge.lane {
            SocketLane::Priority => self.priority = true,
            SocketLane::Egress => self.egress = true,
        }
        if self.complete() {
            self.secret = None;
        }
        Verdict::Accept(challenge.lane)
    }

    /// Both lanes are up: nothing else is accepted.
    pub fn complete(&self) -> bool {
        self.priority && self.egress
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_wire::lane::{self, NONCE_LEN};

    const SECRET: [u8; 32] = [5; 32];

    fn auth() -> LaneAuth {
        match LaneSecret::from_payload(&SECRET) {
            Some(secret) => LaneAuth::new(secret),
            None => panic!("lane secret refused"),
        }
    }

    fn mac(message: &[u8]) -> [u8; 32] {
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &SECRET);
        let tag = ring::hmac::sign(&key, message);
        let mut out = [0u8; 32];
        out.copy_from_slice(tag.as_ref());
        out
    }

    /// The daemon's side, as `lanes.ts` does it: hello, check the server's proof, prove back.
    fn daemon(
        auth: &mut LaneAuth,
        tag: u8,
        client: [u8; NONCE_LEN],
        server: [u8; NONCE_LEN],
    ) -> Verdict {
        let Some(challenge) = auth.challenge(&lane::hello(tag, &client).unwrap_or([0; 37]), server)
        else {
            return Verdict::Refuse;
        };
        let reply = challenge.reply();
        assert_eq!(
            reply[..32],
            mac(&lane::server_message(tag, &client)),
            "server proof"
        );
        assert_eq!(reply[32..], server, "server nonce");
        auth.accept(
            &challenge,
            &mac(&lane::client_message(tag, &client, &server)),
        )
    }

    #[test]
    fn the_proofs_are_the_shared_vectors() {
        let doc: serde_json::Value =
            serde_json::from_str(include_str!("../../../vectors/lane/proofs.json"))
                .unwrap_or_default();
        let hex = |key: &str, from: &serde_json::Value| -> Vec<u8> {
            let text = from[key].as_str().unwrap_or_default();
            (0..text.len())
                .step_by(2)
                .filter_map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
                .collect()
        };
        let secret = hex("secret", &doc);
        let Some(secret) = LaneSecret::from_payload(&secret) else {
            panic!("vector secret")
        };
        let mut auth = LaneAuth::new(secret);
        let client: [u8; NONCE_LEN] = hex("clientNonce", &doc)
            .try_into()
            .unwrap_or([0; NONCE_LEN]);
        let server: [u8; NONCE_LEN] = hex("serverNonce", &doc)
            .try_into()
            .unwrap_or([0; NONCE_LEN]);
        let cases = doc["cases"].as_array().cloned().unwrap_or_default();
        assert_eq!(cases.len(), 2);
        for case in cases {
            let tag = u8::try_from(case["tag"].as_u64().unwrap_or(0)).unwrap_or(0);
            let Some(challenge) =
                auth.challenge(&lane::hello(tag, &client).unwrap_or([0; 37]), server)
            else {
                panic!("tag {tag} refused")
            };
            assert_eq!(challenge.reply()[..32], hex("serverProof", &case)[..]);
            assert!(matches!(
                auth.accept(&challenge, &hex("clientProof", &case)),
                Verdict::Accept(_)
            ));
        }
    }

    #[test]
    fn a_daemon_that_proves_the_secret_gets_each_lane_once_and_nothing_after_both() {
        let mut auth = auth();
        assert_eq!(
            daemon(&mut auth, 1, [1; 32], [2; 32]),
            Verdict::Accept(SocketLane::Priority)
        );
        assert_eq!(
            daemon(&mut auth, 1, [3; 32], [4; 32]),
            Verdict::Refuse,
            "repeated tag"
        );
        assert!(!auth.complete());
        assert_eq!(
            daemon(&mut auth, 2, [5; 32], [6; 32]),
            Verdict::Accept(SocketLane::Egress)
        );
        assert!(auth.complete());
        assert_eq!(daemon(&mut auth, 2, [7; 32], [8; 32]), Verdict::Refuse);
    }

    #[test]
    fn a_replayed_proof_a_proof_for_the_other_direction_and_a_guess_are_refused() {
        let client = [1u8; 32];
        let first = [2u8; 32];
        // A proof that opened an earlier connection, replayed to one with a fresh server nonce.
        let replayed = mac(&lane::client_message(1, &client, &first));
        // ace-media's own proof sent back as the daemon's.
        let reflected = mac(&lane::server_message(1, &client));
        let mut swapped = lane::client_message(1, &client, &[3; 32]);
        swapped[..lane::SERVER_LABEL.len()].copy_from_slice(lane::SERVER_LABEL);
        let wrong_label = mac(&swapped);
        let cases: [(&str, Vec<u8>); 5] = [
            ("replayed", replayed.to_vec()),
            ("reflected server proof", reflected.to_vec()),
            ("wrong direction label", wrong_label.to_vec()),
            ("zeros", vec![0; 32]),
            (
                "short",
                mac(&lane::client_message(1, &client, &[3; 32]))[..31].to_vec(),
            ),
        ];
        for (name, proof) in cases {
            let mut auth = auth();
            let Some(challenge) =
                auth.challenge(&lane::hello(1, &client).unwrap_or([0; 37]), [3; 32])
            else {
                panic!("{name}: hello refused")
            };
            assert_eq!(auth.accept(&challenge, &proof), Verdict::Refuse, "{name}");
            // The refusal took nothing: the right proof still opens the lane.
            assert_eq!(
                daemon(&mut auth, 1, [9; 32], [8; 32]),
                Verdict::Accept(SocketLane::Priority),
                "{name}"
            );
        }
    }

    #[test]
    fn a_hello_that_is_not_exactly_one_is_refused_without_a_reply() {
        let auth = auth();
        let good = lane::hello(1, &[1; 32]).unwrap_or([0; 37]);
        let mut magic = good;
        magic[0] = b'X';
        let mut tag = good;
        tag[4] = 3;
        for bad in [&magic[..], &tag[..], &good[..36]] {
            assert!(auth.challenge(bad, [2; 32]).is_none());
        }
    }
}
