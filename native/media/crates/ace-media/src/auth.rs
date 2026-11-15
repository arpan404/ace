// SPDX-License-Identifier: Apache-2.0
//! Socket lane authentication (docs/media/plan.md, "Lane hello"). Pure: the shell reads the
//! 37 hello bytes and acts on the verdict.
use crate::secret::LaneSecret;

pub const HELLO_LEN: usize = 37;
pub const LANE_MAGIC: &[u8; 4] = b"ACEL";
/// The one byte ace-media answers on an accepted lane.
pub const LANE_ACCEPTED: u8 = 0x01;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SocketLane {
    Priority,
    Egress,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Answer `LANE_ACCEPTED`; the connection carries this lane from now on.
    Accept(SocketLane),
    /// Close without answering.
    Refuse,
}

/// Accepts each socket lane once, for the holder of the lane secret. Once both lanes are up the
/// secret is wiped and every later connection is refused until the process restarts.
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

    pub fn check(&mut self, hello: &[u8]) -> Verdict {
        let Some(secret) = &self.secret else {
            return Verdict::Refuse;
        };
        if hello.len() != HELLO_LEN {
            return Verdict::Refuse;
        }
        // The secret is compared whatever the rest says, so timing tells nothing about it.
        let secret_ok = secret.matches(&hello[5..]);
        let lane = match hello[4] {
            1 if !self.priority => Some(SocketLane::Priority),
            2 if !self.egress => Some(SocketLane::Egress),
            _ => None,
        };
        let (true, true, Some(lane)) = (secret_ok, &hello[..4] == LANE_MAGIC, lane) else {
            return Verdict::Refuse;
        };
        match lane {
            SocketLane::Priority => self.priority = true,
            SocketLane::Egress => self.egress = true,
        }
        if self.complete() {
            self.secret = None;
        }
        Verdict::Accept(lane)
    }

    /// Both lanes are up; the secret is gone.
    pub fn complete(&self) -> bool {
        self.priority && self.egress
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth() -> LaneAuth {
        match LaneSecret::from_payload(&[5; 32]) {
            Some(secret) => LaneAuth::new(secret),
            None => panic!("lane secret refused"),
        }
    }

    fn hello(magic: &[u8; 4], tag: u8, secret: [u8; 32]) -> Vec<u8> {
        let mut bytes = magic.to_vec();
        bytes.push(tag);
        bytes.extend_from_slice(&secret);
        bytes
    }

    #[test]
    fn refuses_every_hello_that_is_not_exactly_a_fresh_lane_with_the_secret() {
        let mut wrong_secret = [5; 32];
        wrong_secret[0] = 4;
        let short = hello(LANE_MAGIC, 1, [5; 32])[..36].to_vec();
        let cases: [(&str, Vec<u8>); 5] = [
            ("wrong secret", hello(LANE_MAGIC, 1, wrong_secret)),
            ("wrong magic", hello(b"ACEX", 1, [5; 32])),
            ("unknown tag", hello(LANE_MAGIC, 3, [5; 32])),
            ("tag zero", hello(LANE_MAGIC, 0, [5; 32])),
            ("short hello", short),
        ];
        for (name, bytes) in cases {
            let mut auth = auth();
            assert_eq!(auth.check(&bytes), Verdict::Refuse, "{name}");
            // A refusal costs nothing: the real lanes still authenticate afterwards.
            assert_eq!(
                auth.check(&hello(LANE_MAGIC, 1, [5; 32])),
                Verdict::Accept(SocketLane::Priority),
                "{name}"
            );
        }
    }

    #[test]
    fn each_lane_is_accepted_once_and_nothing_after_both_are_up() {
        let mut auth = auth();
        let priority = hello(LANE_MAGIC, 1, [5; 32]);
        let egress = hello(LANE_MAGIC, 2, [5; 32]);
        assert_eq!(auth.check(&priority), Verdict::Accept(SocketLane::Priority));
        assert_eq!(auth.check(&priority), Verdict::Refuse, "repeated tag");
        assert!(!auth.complete());
        assert_eq!(auth.check(&egress), Verdict::Accept(SocketLane::Egress));
        assert!(auth.complete());
        assert_eq!(auth.check(&egress), Verdict::Refuse);
        assert_eq!(auth.check(&priority), Verdict::Refuse);
    }
}
