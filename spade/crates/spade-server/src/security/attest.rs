//! The person's say on a change only they may make (ADR 0163, amendment 2): turning Full access
//! on. Spade's bearer token is held by anything ace lets talk to Spade, so it can't tell the
//! person from a process that holds the token. ace's daemon can: it forwards such a change only
//! from the app, a paired device or a fresh sign-in, and stamps it with
//! `x-ace-person: v1.<ms>.<nonce>.<hex HMAC-SHA256>` keyed with a secret only the daemon and Spade
//! read (`<ACE_HOME>/spade-person.key`, written by the daemon, never the token), over what the
//! change is for, so a stamp for one bot and value can't be replayed for another or twice. Each
//! stamp's nonce is claimed in Spade's store before the change is made, so a restart doesn't
//! forget it.

use std::path::PathBuf;

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

/// The header the daemon stamps a person's change with.
pub const HEADER: &str = "x-ace-person";

/// The key's file name in ace's home.
pub const KEY_FILE: &str = "spade-person.key";

/// How far a stamp's time may be from Spade's clock.
pub const WINDOW_MS: i64 = 60_000;

/// What a change refused for want of the person's say tells the caller.
pub const PERSON_ONLY: &str =
    "Only the person can turn on Full access: do it in ace, on this computer or a paired device.";

/// What the stamp signs: the change it is for, and when.
fn message(target: &str, value: &str, at_ms: i64, nonce: &str) -> String {
    format!("ace-spade-person/1\n{target}\n{value}\n{at_ms}\n{nonce}")
}

fn mac(key: &[u8], text: &str) -> Option<Hmac<Sha256>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).ok()?;
    mac.update(text.as_bytes());
    Some(mac)
}

/// The stamp for a change of `target` (a bot's id, or `machine`) to `value` (`full_access`,
/// `auto_review` or `null`). The daemon makes these; Spade's tests too.
pub fn sign(key: &[u8], target: &str, value: &str, at_ms: i64, nonce: &str) -> String {
    let hex: String = mac(key, &message(target, value, at_ms, nonce))
        .map(|mac| {
            mac.finalize()
                .into_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect()
        })
        .unwrap_or_default();
    format!("v1.{at_ms}.{nonce}.{hex}")
}

/// Why a stamp doesn't count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bad {
    Form,
    Stale,
    Signature,
    Replayed,
}

/// The nonce of a stamp good for this change now; never consumes it.
pub fn check(
    key: &[u8],
    stamp: &str,
    target: &str,
    value: &str,
    now_ms: i64,
) -> Result<String, Bad> {
    let mut parts = stamp.trim().splitn(4, '.');
    let (Some("v1"), Some(at), Some(nonce), Some(hex)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Bad::Form);
    };
    let at: i64 = at.parse().map_err(|_| Bad::Form)?;
    let nonce_ok = (16..=64).contains(&nonce.len()) && nonce.bytes().all(|b| b.is_ascii_hexdigit());
    if !nonce_ok || hex.len() != 64 {
        return Err(Bad::Form);
    }
    if (now_ms - at).abs() > WINDOW_MS {
        return Err(Bad::Stale);
    }
    let given: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
        .collect::<Result<_, _>>()
        .map_err(|_| Bad::Form)?;
    let mac = mac(key, &message(target, value, at, nonce)).ok_or(Bad::Signature)?;
    // Compared in constant time.
    mac.verify_slice(&given).map_err(|_| Bad::Signature)?;
    Ok(nonce.to_owned())
}

/// Reads the shared key and takes each stamp once, through `claim` (Spade's store).
pub struct Attestor {
    key: Option<PathBuf>,
}

/// Where a taken stamp's nonce is kept, in Spade's settings, until it is too old to count.
pub const CLAIMED: &str = "person_stamp:";

impl Attestor {
    /// `key`: where the daemon writes the shared key; `None` takes no stamp at all.
    pub fn new(key: Option<PathBuf>) -> Self {
        Self { key }
    }

    /// The key, read now (the daemon may write it after Spade starts): hex, at least 32 bytes.
    fn key(&self) -> Option<Vec<u8>> {
        let text = std::fs::read_to_string(self.key.as_ref()?).ok()?;
        let text = text.trim();
        if text.len() < 64 || text.len() % 2 != 0 {
            return None;
        }
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
            .collect()
    }

    /// Whether `stamp` is the person's say on this change. A good stamp is used up by `claim`
    /// (its nonce, now), which answers `false` for one taken before, in this run or an earlier
    /// one, or when it can't record it.
    pub fn person(
        &self,
        stamp: Option<&str>,
        target: &str,
        value: &str,
        now_ms: i64,
        claim: &dyn Fn(&str, i64) -> bool,
    ) -> bool {
        let (Some(stamp), Some(key)) = (stamp, self.key()) else {
            return false;
        };
        let Ok(nonce) = check(&key, stamp, target, value, now_ms) else {
            return false;
        };
        claim(&nonce, now_ms)
    }
}

/// Claims `nonce` in `store`, dropping claims too old to matter: a stamp is good for
/// [`WINDOW_MS`] either side of Spade's clock.
pub fn claim_in(store: &spade_store::Store, nonce: &str, now_ms: i64) -> bool {
    store
        .claim_once(CLAIMED, nonce, now_ms, now_ms - 2 * WINDOW_MS)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"0123456789abcdef0123456789abcdef";
    const NONCE: &str = "00112233445566778899aabbccddeeff";

    #[test]
    fn a_stamp_counts_only_for_its_bot_value_and_time_with_the_shared_key() {
        let stamp = sign(KEY, "a_1", "full_access", 1_000_000, NONCE);
        assert_eq!(
            check(KEY, &stamp, "a_1", "full_access", 1_010_000),
            Ok(NONCE.to_owned())
        );
        let cases = [
            (KEY, "a_2", "full_access", 1_010_000, Bad::Signature),
            (KEY, "a_1", "null", 1_010_000, Bad::Signature),
            (KEY, "machine", "full_access", 1_010_000, Bad::Signature),
            (
                KEY,
                "a_1",
                "full_access",
                1_000_000 + WINDOW_MS + 1,
                Bad::Stale,
            ),
            (
                b"another key, not the shared one!".as_slice(),
                "a_1",
                "full_access",
                1_010_000,
                Bad::Signature,
            ),
        ];
        for (key, target, value, now, bad) in cases {
            assert_eq!(
                check(key, &stamp, target, value, now),
                Err(bad),
                "{target} {value}"
            );
        }
        // The bearer token's own proof isn't a stamp, nor is anything else.
        for wrong in ["", "Bearer abc", "v1.x.y.z", &stamp.replace("v1", "v2")] {
            assert_eq!(
                check(KEY, wrong, "a_1", "full_access", 1_010_000),
                Err(Bad::Form)
            );
        }
    }

    #[test]
    fn a_stamp_ace_s_daemon_makes_is_one_spade_takes() {
        // The vector in the daemon's `person-stamp.test.ts`; computed independently with
        // Python's hmac.new(bytes(range(32)), message, sha256).
        let key: Vec<u8> = (0u8..32).collect();
        let stamp = "v1.1700000000000.00112233445566778899aabbccddeeff.\
                     9d4be3f27e7c4b4e0aadae6e330483846f5ea77ecbe60121799f8c4b3c9b4149";
        assert_eq!(
            sign(&key, "a_1", "full_access", 1_700_000_000_000, NONCE),
            stamp
        );
        assert!(check(&key, stamp, "a_1", "full_access", 1_700_000_000_000).is_ok());
    }

    #[test]
    fn a_stamp_is_used_once_even_after_a_restart_and_needs_the_key_file() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let path = dir.path().join(KEY_FILE);
        let hex: String = KEY.iter().map(|b| format!("{b:02x}")).collect();
        let stamp = sign(KEY, "a_1", "full_access", 5_000, NONCE);
        let database = dir.path().join("spade.sqlite");
        let store = spade_store::Store::open(&database).unwrap_or_else(|_| std::process::abort());
        let claim = |nonce: &str, now: i64| claim_in(&store, nonce, now);
        let without = Attestor::new(Some(path.clone()));
        assert!(!without.person(Some(&stamp), "a_1", "full_access", 5_000, &claim));
        std::fs::write(&path, hex).unwrap_or_else(|_| std::process::abort());
        let attestor = Attestor::new(Some(path.clone()));
        assert!(!attestor.person(None, "a_1", "full_access", 5_000, &claim));
        assert!(attestor.person(Some(&stamp), "a_1", "full_access", 5_000, &claim));
        assert!(
            !attestor.person(Some(&stamp), "a_1", "full_access", 5_001, &claim),
            "replayed"
        );
        // Spade restarted: a new attestor over the same database still refuses it.
        drop(store);
        let reopened =
            spade_store::Store::open(&database).unwrap_or_else(|_| std::process::abort());
        let claim = |nonce: &str, now: i64| claim_in(&reopened, nonce, now);
        let restarted = Attestor::new(Some(path));
        assert!(
            !restarted.person(Some(&stamp), "a_1", "full_access", 5_002, &claim),
            "replayed after a restart"
        );
        // A claim long expired is dropped, and nothing else in the settings is.
        reopened
            .set_setting("security.machine", Some("{}"))
            .unwrap_or_else(|_| std::process::abort());
        let fresh = sign(
            KEY,
            "a_1",
            "full_access",
            400_000,
            "ffeeddccbbaa99887766554433221100",
        );
        assert!(restarted.person(Some(&fresh), "a_1", "full_access", 400_000, &claim));
        assert_eq!(
            reopened
                .claim_once(CLAIMED, NONCE, 400_000, 400_000 - 2 * WINDOW_MS)
                .ok(),
            Some(true),
            "the old claim was pruned"
        );
        assert!(
            reopened
                .setting("security.machine")
                .ok()
                .flatten()
                .is_some()
        );
        assert!(!Attestor::new(None).person(Some(&stamp), "a_1", "full_access", 5_000, &claim));
    }
}
