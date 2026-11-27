// SPDX-License-Identifier: Apache-2.0
//! Identifiers the daemon writes: the token, the host id, the run's owner and a
//! shutdown receipt's id. All of them come from the OS CSPRNG, as the
//! TypeScript's `randomBytes` and `randomUUID` do.

use std::fmt::Write as _;

/// Why an identifier could not be made.
#[derive(Debug)]
pub struct RandomError(getrandom::Error);

impl std::fmt::Display for RandomError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "the OS random source failed: {}", self.0)
    }
}

impl std::error::Error for RandomError {}

/// `length` bytes from the OS CSPRNG.
pub fn bytes(length: usize) -> Result<Vec<u8>, RandomError> {
    let mut buffer = vec![0_u8; length];
    getrandom::fill(&mut buffer).map_err(RandomError)?;
    Ok(buffer)
}

/// Lowercase hex, as `Buffer.toString("hex")`.
pub fn hex(data: &[u8]) -> String {
    let mut text = String::with_capacity(data.len() * 2);
    for byte in data {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

/// 32 random bytes as 64 hex characters: the daemon token and the Suit URL key.
pub fn random_hex_32() -> Result<String, RandomError> {
    Ok(hex(&bytes(32)?))
}

/// `crypto.randomUUID()`: a version-4 UUID in its hyphenated form.
pub fn uuid_v4() -> Result<String, RandomError> {
    let mut raw = bytes(16)?;
    // Version 4 and the RFC 4122 variant, as randomUUID writes them.
    raw[6] = (raw[6] & 0x0f) | 0x40;
    raw[8] = (raw[8] & 0x3f) | 0x80;
    let text = hex(&raw);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &text[0..8],
        &text[8..12],
        &text[12..16],
        &text[16..20],
        &text[20..32]
    ))
}
