//! The person's say on a change only they may make (ADR 0163, amendment 2): turning Full access
//! on. Spade's bearer token is held by anything ace lets talk to Spade, so it can't tell the
//! person from a process that holds the token. ace's daemon can: it forwards such a change only
//! from the app, a paired device or a fresh sign-in, and stamps it with
//! `x-ace-person: v1.<ms>.<nonce>.<hex HMAC-SHA256>` keyed with a secret only the daemon and Spade
//! read (`<ACE_HOME>/spade-person.key`, written by the daemon, never the token), over what the
//! change is for, so a stamp for one bot and value can't be replayed for another or twice.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

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

/// Reads the shared key and remembers the stamps it has taken, so each counts once.
pub struct Attestor {
    key: Option<PathBuf>,
    seen: Mutex<HashMap<String, i64>>,
}

impl Attestor {
    /// `key`: where the daemon writes the shared key; `None` takes no stamp at all.
    pub fn new(key: Option<PathBuf>) -> Self {
        Self {
            key,
            seen: Mutex::default(),
        }
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

    /// Whether `stamp` is the person's say on this change; a good stamp is used up.
    pub fn person(&self, stamp: Option<&str>, target: &str, value: &str, now_ms: i64) -> bool {
        let (Some(stamp), Some(key)) = (stamp, self.key()) else {
            return false;
        };
        let Ok(nonce) = check(&key, stamp, target, value, now_ms) else {
            return false;
        };
        let mut seen = self.seen.lock().unwrap_or_else(|p| p.into_inner());
        seen.retain(|_, at| now_ms - *at <= 2 * WINDOW_MS);
        if seen.contains_key(&nonce) {
            return false;
        }
        seen.insert(nonce, now_ms);
        true
    }
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
    fn a_stamp_is_used_once_and_needs_the_key_file() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let path = dir.path().join(KEY_FILE);
        let hex: String = KEY.iter().map(|b| format!("{b:02x}")).collect();
        let stamp = sign(KEY, "a_1", "full_access", 5_000, NONCE);
        let without = Attestor::new(Some(path.clone()));
        assert!(!without.person(Some(&stamp), "a_1", "full_access", 5_000));
        std::fs::write(&path, hex).unwrap_or_else(|_| std::process::abort());
        let attestor = Attestor::new(Some(path));
        assert!(!attestor.person(None, "a_1", "full_access", 5_000));
        assert!(attestor.person(Some(&stamp), "a_1", "full_access", 5_000));
        assert!(
            !attestor.person(Some(&stamp), "a_1", "full_access", 5_001),
            "replayed"
        );
        assert!(!Attestor::new(None).person(Some(&stamp), "a_1", "full_access", 5_000));
    }
}
