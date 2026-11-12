//! Sign-ins in progress, in memory, each living at most [`SIGN_IN_SECONDS`]: the OAuth `state`,
//! the account and app it belongs to, Spade's PKCE challenge and one-time public key, and the
//! authorization code from the time the maker redirects back until Spade collects it. Nothing
//! else; no token is ever kept here. Pure apart from the time callers pass, so a database can
//! later stand behind the same calls.

use std::collections::HashMap;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::digest::{SHA256, digest};
use spade_cloud_wire::SIGN_IN_SECONDS;

/// Most sign-ins in progress per account; a newer one drops the oldest.
pub const MOST_PER_ACCOUNT: usize = 5;
/// Most sign-ins in progress at all.
pub const MOST_IN_ALL: usize = 50_000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Outcome {
    Waiting,
    Code(String),
    Declined,
}

#[derive(Clone)]
pub struct SignIn {
    /// What Spade names it by.
    pub handle: String,
    /// The OAuth `state`, which only the maker and the person's browser see.
    pub state: String,
    pub account: String,
    pub app: String,
    pub challenge: String,
    pub public_key: String,
    pub started_ms: u64,
    outcome: Outcome,
}

impl SignIn {
    pub fn new(
        handle: String,
        state: String,
        account: String,
        app: String,
        challenge: String,
        public_key: String,
        started_ms: u64,
    ) -> Self {
        Self {
            handle,
            state,
            account,
            app,
            challenge,
            public_key,
            started_ms,
            outcome: Outcome::Waiting,
        }
    }

    fn expired(&self, now_ms: u64) -> bool {
        now_ms.saturating_sub(self.started_ms) >= SIGN_IN_SECONDS * 1000
    }
}

/// What the maker's redirect did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Callback {
    /// The code is kept for Spade to collect.
    Accepted {
        account: String,
        app: String,
    },
    /// The person declined, or the answer named another issuer: Spade is told it was declined.
    Declined {
        account: String,
        app: String,
    },
    /// No such state, or it already came back once.
    Unknown,
    Expired,
}

/// What Spade's finish found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Finish {
    /// The code and the key to seal the tokens to; the sign-in is gone.
    Ready {
        code: String,
        public_key: String,
    },
    Waiting,
    /// No sign-in by that handle for this account and app.
    Unknown,
    Expired,
    /// The verifier doesn't match; the sign-in is gone.
    WrongVerifier,
    /// The person declined; the sign-in is gone.
    Declined,
}

#[derive(Default)]
pub struct SignIns {
    by_handle: HashMap<String, SignIn>,
    handles: HashMap<String, String>,
}

impl SignIns {
    /// Keeps a new sign-in. `false` when the service holds as many as it may.
    pub fn begin(&mut self, sign_in: SignIn, now_ms: u64) -> bool {
        self.prune(now_ms);
        let mut mine: Vec<(u64, String)> = self
            .by_handle
            .values()
            .filter(|s| s.account == sign_in.account)
            .map(|s| (s.started_ms, s.handle.clone()))
            .collect();
        mine.sort();
        while mine.len() >= MOST_PER_ACCOUNT {
            let (_, oldest) = mine.remove(0);
            self.remove(&oldest);
        }
        if self.by_handle.len() >= MOST_IN_ALL {
            return false;
        }
        self.handles
            .insert(sign_in.state.clone(), sign_in.handle.clone());
        self.by_handle.insert(sign_in.handle.clone(), sign_in);
        true
    }

    /// The app a sign-in in progress is for, by its `state`.
    pub fn app_of(&self, state: &str) -> Option<String> {
        let handle = self.handles.get(state)?;
        self.by_handle.get(handle).map(|s| s.app.clone())
    }

    /// The maker redirected back with `state`. `issuer_ok` is the RFC 9207 check of `iss`.
    pub fn callback(
        &mut self,
        state: &str,
        code: Option<&str>,
        declined: bool,
        issuer_ok: bool,
        now_ms: u64,
    ) -> Callback {
        let Some(handle) = self.handles.get(state).cloned() else {
            return Callback::Unknown;
        };
        let Some(sign_in) = self.by_handle.get_mut(&handle) else {
            return Callback::Unknown;
        };
        if sign_in.expired(now_ms) {
            self.remove(&handle);
            return Callback::Expired;
        }
        if sign_in.outcome != Outcome::Waiting {
            // A second answer for one state is a replay; the first stands.
            return Callback::Unknown;
        }
        let (account, app) = (sign_in.account.clone(), sign_in.app.clone());
        match code.filter(|c| !c.is_empty()) {
            Some(code) if issuer_ok && !declined => {
                sign_in.outcome = Outcome::Code(code.to_owned());
                Callback::Accepted { account, app }
            }
            _ => {
                sign_in.outcome = Outcome::Declined;
                Callback::Declined { account, app }
            }
        }
    }

    /// Spade asks for its sign-in with the PKCE verifier. Another account, or another app, finds
    /// nothing and changes nothing.
    pub fn finish(
        &mut self,
        handle: &str,
        account: &str,
        app: &str,
        verifier: &str,
        now_ms: u64,
    ) -> Finish {
        let Some(sign_in) = self.by_handle.get(handle) else {
            return Finish::Unknown;
        };
        if sign_in.account != account || sign_in.app != app {
            return Finish::Unknown;
        }
        if sign_in.expired(now_ms) {
            self.remove(handle);
            return Finish::Expired;
        }
        if !matches_challenge(verifier, &sign_in.challenge) {
            self.remove(handle);
            return Finish::WrongVerifier;
        }
        match &sign_in.outcome {
            Outcome::Waiting => Finish::Waiting,
            Outcome::Declined => {
                self.remove(handle);
                Finish::Declined
            }
            Outcome::Code(code) => {
                let ready = Finish::Ready {
                    code: code.clone(),
                    public_key: sign_in.public_key.clone(),
                };
                self.remove(handle);
                ready
            }
        }
    }

    /// How many sign-ins are held: what tests check to see nothing is kept.
    pub fn len(&self) -> usize {
        self.by_handle.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_handle.is_empty()
    }

    fn remove(&mut self, handle: &str) {
        if let Some(sign_in) = self.by_handle.remove(handle) {
            self.handles.remove(&sign_in.state);
        }
    }

    fn prune(&mut self, now_ms: u64) {
        let gone: Vec<String> = self
            .by_handle
            .values()
            .filter(|s| s.expired(now_ms))
            .map(|s| s.handle.clone())
            .collect();
        for handle in gone {
            self.remove(&handle);
        }
    }
}

/// RFC 7636 S256: the challenge is base64url(SHA-256(verifier)). Verifiers are 43 to 128
/// unreserved characters.
pub fn matches_challenge(verifier: &str, challenge: &str) -> bool {
    (43..=128).contains(&verifier.len())
        && verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~'))
        && URL_SAFE_NO_PAD.encode(digest(&SHA256, verifier.as_bytes())) == challenge
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    fn sign_in(handle: &str, account: &str, at: u64) -> SignIn {
        SignIn::new(
            handle.into(),
            format!("state-{handle}"),
            account.into(),
            "asana".into(),
            CHALLENGE.into(),
            "key".into(),
            at,
        )
    }

    #[test]
    fn the_challenge_check_is_rfc_7636_s256() {
        assert!(matches_challenge(VERIFIER, CHALLENGE));
        assert!(!matches_challenge("short", CHALLENGE));
        assert!(!matches_challenge(&VERIFIER.replace('d', "e"), CHALLENGE));
    }

    #[test]
    fn an_account_keeps_at_most_five_sign_ins_and_the_oldest_goes_first() {
        let mut sign_ins = SignIns::default();
        for n in 0..6 {
            assert!(sign_ins.begin(sign_in(&n.to_string(), "a", n), n));
        }
        assert_eq!(sign_ins.len(), 5);
        assert_eq!(
            sign_ins.finish("0", "a", "asana", VERIFIER, 10),
            Finish::Unknown
        );
        assert_eq!(
            sign_ins.finish("5", "a", "asana", VERIFIER, 10),
            Finish::Waiting
        );
    }

    #[test]
    fn expired_sign_ins_are_dropped_when_the_next_one_begins() {
        let mut sign_ins = SignIns::default();
        sign_ins.begin(sign_in("old", "a", 0), 0);
        sign_ins.begin(
            sign_in("new", "b", SIGN_IN_SECONDS * 1000),
            SIGN_IN_SECONDS * 1000,
        );
        assert_eq!(sign_ins.len(), 1);
    }
}
