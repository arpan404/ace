//! A member's say on a shared bot (ADR 0206 §2.3): the person stamp of ADR 0163 amendment 2
//! with the member added under the HMAC. ace's daemon adds it only from a socket with member
//! standing whose account holds the needed right on that bot, and Spade checks that right again
//! itself. Same key (`spade-person.key`), another domain, so a person stamp is never a member's
//! and the other way round:
//!
//! - `x-ace-member: v1.<ms>.<nonce>.<account>.<hex HMAC-SHA256>`
//! - `x-ace-member-role: <role slug>` (signed; a missing one is signed as `member`)
//! - `x-ace-member-name: <name>` (for the record only; not signed, never authorizes)
//!
//! over `ace-spade-member/1\n<target>\n<value>\n<account>\n<role>\n<ms>\n<nonce>`. Each nonce is
//! claimed once in Spade's store, with the person stamps'.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use spade_core::org::Member;
use spade_core::org::access::plain_account;

use super::attest::{Bad, WINDOW_MS};

pub const HEADER: &str = "x-ace-member";
pub const ROLE_HEADER: &str = "x-ace-member-role";
pub const NAME_HEADER: &str = "x-ace-member-name";

/// The role a stamp is signed for when it names none.
const NO_ROLE: &str = "member";

fn message(target: &str, value: &str, account: &str, role: &str, at: i64, nonce: &str) -> String {
    format!("ace-spade-member/1\n{target}\n{value}\n{account}\n{role}\n{at}\n{nonce}")
}

fn mac(key: &[u8], text: &str) -> Option<Hmac<Sha256>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).ok()?;
    mac.update(text.as_bytes());
    Some(mac)
}

/// The stamp for `member`'s say on `target` becoming `value`. The daemon makes these; Spade's
/// tests too.
pub fn sign(
    key: &[u8],
    member: &Member,
    target: &str,
    value: &str,
    at: i64,
    nonce: &str,
) -> String {
    let text = message(target, value, &member.account, &member.role, at, nonce);
    let hex: String = mac(key, &text)
        .map(|mac| {
            mac.finalize()
                .into_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect()
        })
        .unwrap_or_default();
    format!("v1.{at}.{nonce}.{}.{hex}", member.account)
}

/// The member and nonce of a stamp good for this change now; never consumes it.
pub fn check(
    key: &[u8],
    stamp: &str,
    role: Option<&str>,
    target: &str,
    value: &str,
    now_ms: i64,
) -> Result<(Member, String), Bad> {
    let mut parts = stamp.trim().splitn(5, '.');
    let (Some("v1"), Some(at), Some(nonce), Some(account), Some(hex)) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return Err(Bad::Form);
    };
    let at: i64 = at.parse().map_err(|_| Bad::Form)?;
    let role = role.map_or(NO_ROLE, str::trim);
    let nonce_ok = (16..=64).contains(&nonce.len()) && nonce.bytes().all(|b| b.is_ascii_hexdigit());
    let role_ok = !role.is_empty()
        && role.len() <= 64
        && role
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'-'));
    if !nonce_ok || !role_ok || !plain_account(account) || hex.len() != 64 {
        return Err(Bad::Form);
    }
    if (now_ms - at).abs() > WINDOW_MS {
        return Err(Bad::Stale);
    }
    let given: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| {
            hex.get(i..i + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
        })
        .collect::<Option<_>>()
        .ok_or(Bad::Form)?;
    let mac = mac(key, &message(target, value, account, role, at, nonce)).ok_or(Bad::Signature)?;
    mac.verify_slice(&given).map_err(|_| Bad::Signature)?;
    Ok((
        Member {
            account: account.to_owned(),
            role: role.to_owned(),
            name: None,
        },
        nonce.to_owned(),
    ))
}

/// A name from the unsigned header, made safe to keep: one line, at most 128 characters.
pub fn name(header: Option<&str>) -> Option<String> {
    let name: String = header?
        .chars()
        .filter(|c| !c.is_control())
        .take(128)
        .collect();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"0123456789abcdef0123456789abcdef";
    const NONCE: &str = "00112233445566778899aabbccddeeff";

    fn ana(role: &str) -> Member {
        Member {
            account: "user_ana".to_owned(),
            role: role.to_owned(),
            name: None,
        }
    }

    #[test]
    fn a_member_stamp_counts_only_for_its_member_role_change_and_time() {
        let stamp = sign(
            KEY,
            &ana("admin"),
            "a_1:answer:k_1",
            "allow",
            1_000_000,
            NONCE,
        );
        let ok = check(
            KEY,
            &stamp,
            Some("admin"),
            "a_1:answer:k_1",
            "allow",
            1_000_500,
        );
        assert_eq!(ok.map(|(m, _)| m), Ok(ana("admin")));
        // Another role than the one signed: a member can't call themselves an admin.
        assert_eq!(
            check(
                KEY,
                &stamp,
                Some("owner"),
                "a_1:answer:k_1",
                "allow",
                1_000_500
            )
            .map(|_| ()),
            Err(Bad::Signature)
        );
        assert_eq!(
            check(KEY, &stamp, None, "a_1:answer:k_1", "allow", 1_000_500).map(|_| ()),
            Err(Bad::Signature)
        );
        // Another account in the stamp's place is another stamp.
        let respelled = stamp.replace("user_ana", "user_bob");
        assert_eq!(
            check(
                KEY,
                &respelled,
                Some("admin"),
                "a_1:answer:k_1",
                "allow",
                1_000_500
            )
            .map(|_| ()),
            Err(Bad::Signature)
        );
        for (target, value, now, bad) in [
            ("a_2:answer:k_1", "allow", 1_000_500, Bad::Signature),
            ("a_1:answer:k_1", "deny", 1_000_500, Bad::Signature),
            (
                "a_1:answer:k_1",
                "allow",
                1_000_000 + WINDOW_MS + 1,
                Bad::Stale,
            ),
        ] {
            assert_eq!(
                check(KEY, &stamp, Some("admin"), target, value, now).map(|_| ()),
                Err(bad),
                "{target} {value}"
            );
        }
        // A person stamp for the same change isn't a member's.
        let person = super::super::attest::sign(KEY, "a_1:answer:k_1", "allow", 1_000_000, NONCE);
        assert!(
            check(
                KEY,
                &person,
                Some("admin"),
                "a_1:answer:k_1",
                "allow",
                1_000_500
            )
            .is_err()
        );
    }

    #[test]
    fn a_members_name_is_kept_on_one_short_line() {
        assert_eq!(name(Some(" Ana\nLee ")), Some("AnaLee".to_owned()));
        assert_eq!(name(Some("   ")), None);
        assert_eq!(name(Some(&"x".repeat(500))).map(|n| n.len()), Some(128));
    }
}
