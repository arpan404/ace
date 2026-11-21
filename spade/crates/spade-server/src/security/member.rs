//! A member's say on a shared bot (ADR 0206 §2.3): the person stamp of ADR 0163 amendment 2
//! with the member's account added under the HMAC, keyed with the same secret
//! (`spade-person.key`). ace's daemon adds one only from a socket whose member standing is
//! current; it holds no access list, so Spade checks the member's right on the bot itself.
//!
//! Two stamps, in two domains, so neither stands in for the other or for a person's:
//!
//! - **An answer** to a raised request, as the daemon makes it (`apps/daemon/src/spade/
//!   member-stamp.ts`, `member-vector.json` is its output): `x-ace-member:
//!   v1.<ms>.<nonce>.<account>.<hex HMAC-SHA256>` over
//!   `ace-spade-member/1\n<target>\n<value>\n<account>\n<ms>\n<nonce>`, where `target` is
//!   `approval:<conversation>:<call>` or `outside:<conversation>:<ask>` and `value`
//!   `allowed=<bool>;always=<bool>`. It carries no role: Spade reads its member as `member`.
//! - **Any other write** to a shared bot (a message, a grant, its access list, Full access, a
//!   move): `x-ace-member-request: v1.<ms>.<nonce>.<account>.<hex>` over
//!   `ace-spade-member-request/1\n<METHOD> <path>\n<hex SHA-256 of the body>\n<account>\n<role>\n<ms>\n<nonce>`,
//!   with the role signed from `x-ace-member-role` (absent is signed as `member`). The daemon
//!   doesn't make these yet: until it does, Spade refuses those writes on a shared bot.
//!
//! `x-ace-member-name` is recorded only and never authorizes. Each nonce is claimed once in
//! Spade's store, with the person stamps'.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use spade_core::org::Member;
use spade_core::org::access::plain_account;

use super::attest::{Bad, WINDOW_MS};

/// An answer's stamp.
pub const HEADER: &str = "x-ace-member";
/// Any other write's stamp.
pub const REQUEST_HEADER: &str = "x-ace-member-request";
pub const ROLE_HEADER: &str = "x-ace-member-role";
pub const NAME_HEADER: &str = "x-ace-member-name";

/// The role a member is read as when the stamp names none.
const NO_ROLE: &str = "member";

/// What an answer's stamp names: `approval:<conversation>:<call>`.
pub fn approval_target(conversation: &str, call: &str) -> String {
    format!("approval:{conversation}:{call}")
}

/// What an answer to a plugin's request to run outside names: `outside:<conversation>:<ask>`.
pub fn outside_target(conversation: &str, ask: &str) -> String {
    format!("outside:{conversation}:{ask}")
}

/// What an answer's stamp says was answered.
pub fn answer_value(allowed: bool, always: bool) -> String {
    format!("allowed={allowed};always={always}")
}

fn hex_mac(key: &[u8], text: &str) -> String {
    Hmac::<Sha256>::new_from_slice(key)
        .map(|mut mac| {
            mac.update(text.as_bytes());
            mac.finalize()
                .into_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect()
        })
        .unwrap_or_default()
}

/// Checks `given` (hex) against the HMAC of `text`, in constant time.
fn verifies(key: &[u8], text: &str, given: &str) -> Result<(), Bad> {
    let bytes: Vec<u8> = (0..given.len())
        .step_by(2)
        .map(|i| {
            given
                .get(i..i + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
        })
        .collect::<Option<_>>()
        .ok_or(Bad::Form)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| Bad::Signature)?;
    mac.update(text.as_bytes());
    mac.verify_slice(&bytes).map_err(|_| Bad::Signature)
}

/// A stamp's parts: its time, nonce, account and HMAC, checked for form and freshness.
fn parts(stamp: &str, now_ms: i64) -> Result<(i64, &str, &str, &str), Bad> {
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
    let nonce_ok = (16..=64).contains(&nonce.len()) && nonce.bytes().all(|b| b.is_ascii_hexdigit());
    if !nonce_ok || !plain_account(account) || hex.len() != 64 {
        return Err(Bad::Form);
    }
    if (now_ms - at).abs() > WINDOW_MS {
        return Err(Bad::Stale);
    }
    Ok((at, nonce, account, hex))
}

fn answer_message(target: &str, value: &str, account: &str, at: i64, nonce: &str) -> String {
    format!("ace-spade-member/1\n{target}\n{value}\n{account}\n{at}\n{nonce}")
}

/// An answer's stamp for `account`, as the daemon makes it; Spade's tests make these too.
pub fn sign_answer(
    key: &[u8],
    account: &str,
    target: &str,
    value: &str,
    at: i64,
    nonce: &str,
) -> String {
    let mac = hex_mac(key, &answer_message(target, value, account, at, nonce));
    format!("v1.{at}.{nonce}.{account}.{mac}")
}

/// The member and nonce of an answer's stamp good for `target` answered `value` now; never
/// consumes it.
pub fn check_answer(
    key: &[u8],
    stamp: &str,
    target: &str,
    value: &str,
    now_ms: i64,
) -> Result<(Member, String), Bad> {
    let (at, nonce, account, hex) = parts(stamp, now_ms)?;
    verifies(key, &answer_message(target, value, account, at, nonce), hex)?;
    Ok((
        Member {
            account: account.to_owned(),
            role: NO_ROLE.to_owned(),
            name: None,
        },
        nonce.to_owned(),
    ))
}

fn request_message(
    target: &str,
    value: &str,
    account: &str,
    role: &str,
    at: i64,
    nonce: &str,
) -> String {
    format!("ace-spade-member-request/1\n{target}\n{value}\n{account}\n{role}\n{at}\n{nonce}")
}

/// Any other write's stamp for `member` over `target` (`<METHOD> <path>`) and `value` (the hex
/// SHA-256 of its body).
pub fn sign_request(
    key: &[u8],
    member: &Member,
    target: &str,
    value: &str,
    at: i64,
    nonce: &str,
) -> String {
    let text = request_message(target, value, &member.account, &member.role, at, nonce);
    format!("v1.{at}.{nonce}.{}.{}", member.account, hex_mac(key, &text))
}

/// The member and nonce of a write's stamp good for this request now; never consumes it.
pub fn check_request(
    key: &[u8],
    stamp: &str,
    role: Option<&str>,
    target: &str,
    value: &str,
    now_ms: i64,
) -> Result<(Member, String), Bad> {
    let (at, nonce, account, hex) = parts(stamp, now_ms)?;
    let role = role.map_or(NO_ROLE, str::trim);
    let role_ok = !role.is_empty()
        && role.len() <= 64
        && role
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'-'));
    if !role_ok {
        return Err(Bad::Form);
    }
    verifies(
        key,
        &request_message(target, value, account, role, at, nonce),
        hex,
    )?;
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
mod tests;
