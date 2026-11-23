// SPDX-License-Identifier: Apache-2.0
//! Validated newtypes for daemon credentials and identifiers.

use std::fmt;

use crate::error::WireError;

/// Exact length of a hex-encoded 32-byte daemon token, ticket, or SHA-256 fingerprint.
pub const HEX64_LEN: usize = 64;

/// A 64-character lowercase hexadecimal daemon host or device token (`/^[0-9a-f]{64}$/`).
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    /// Parses a token, requiring exactly 64 lowercase hexadecimal ASCII characters.
    pub fn parse(raw: impl Into<String>) -> Result<Self, WireError> {
        let value = raw.into();
        if is_hex64(&value) {
            Ok(Self(value))
        } else {
            Err(WireError::Auth {
                detail: "Invalid daemon token format".into(),
                revoked: false,
            })
        }
    }

    /// Raw token string for wire headers and hello frames.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token([redacted])")
    }
}

/// A 64-character lowercase hexadecimal single-use WebSocket ticket (`/^[0-9a-f]{64}$/`).
#[derive(Clone, PartialEq, Eq)]
pub struct Ticket(String);

impl Ticket {
    /// Parses a ticket, requiring exactly 64 lowercase hexadecimal ASCII characters.
    pub fn parse(raw: impl Into<String>) -> Result<Self, WireError> {
        let value = raw.into();
        if is_hex64(&value) {
            Ok(Self(value))
        } else {
            Err(WireError::Auth {
                detail: "Invalid socket ticket format".into(),
                revoked: false,
            })
        }
    }

    /// Raw ticket string for the WebSocket `hello` frame.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Ticket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Ticket([redacted])")
    }
}

/// SHA-256 fingerprint of a certificate's DER-encoded `SubjectPublicKeyInfo` (`[0-9a-f]{64}`).
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Fingerprint {
    hex: String,
    bytes: [u8; 32],
}

impl Fingerprint {
    /// Parses a 64-character lowercase hexadecimal SHA-256 fingerprint.
    pub fn parse(raw: impl Into<String>) -> Result<Self, WireError> {
        let hex = raw.into();
        let bytes = decode_hex32(&hex).ok_or_else(|| WireError::InvalidTarget {
            detail: "Invalid public-key fingerprint".into(),
        })?;
        Ok(Self { hex, bytes })
    }

    /// Constructs a fingerprint from raw 32-byte SHA-256 digest bytes.
    #[must_use]
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        const LUT: &[u8; 16] = b"0123456789abcdef";
        let mut hex = String::with_capacity(HEX64_LEN);
        for byte in bytes {
            hex.push(char::from(LUT[usize::from(byte >> 4)]));
            hex.push(char::from(LUT[usize::from(byte & 0x0f)]));
        }
        Self { hex, bytes }
    }

    /// Lowercase hex representation (64 chars).
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.hex
    }

    /// Raw 32-byte SHA-256 digest.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.bytes
    }

    /// Constant-time comparison against another 32-byte digest.
    #[must_use]
    pub fn ct_eq_bytes(&self, other: &[u8; 32]) -> bool {
        let mut diff = 0u8;
        for (a, b) in self.bytes.iter().zip(other.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }
}

impl fmt::Debug for Fingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Fingerprint").field(&self.hex).finish()
    }
}

impl fmt::Display for Fingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.hex)
    }
}

/// Who is calling the local daemon (`person-gate.ts`: `localDevice(agentShell(env))`).
///
/// Required by [`crate::Connection::open_local`] so an agent shell (`ACE_THREAD_ID` or
/// `ACE_NO_INPUT`) can never silently connect as `"ace-cli"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LocalIdentity {
    /// The person at their own terminal (`deviceId: "ace-cli"`).
    Person,
    /// An agent shell (`ACE_THREAD_ID` non-empty or `ACE_NO_INPUT` enabled; `deviceId: "ace-agent"`).
    Agent,
}

impl LocalIdentity {
    /// Selects [`Self::Agent`] when `ACE_THREAD_ID` is non-empty or `ACE_NO_INPUT` is enabled in
    /// the current process environment, otherwise [`Self::Person`].
    #[must_use]
    pub fn from_env() -> Self {
        let thread_id = std::env::var("ACE_THREAD_ID").ok();
        let no_input = std::env::var("ACE_NO_INPUT").ok();
        Self::from_vars(thread_id.as_deref(), no_input.as_deref())
    }

    /// Pure identity check matching `agentShell(env)` in `apps/daemon/src/cli/person-gate.ts`.
    #[must_use]
    pub fn from_vars(ace_thread_id: Option<&str>, ace_no_input: Option<&str>) -> Self {
        let in_thread = ace_thread_id.is_some_and(|v| !v.trim().is_empty());
        if in_thread || env_on(ace_no_input) {
            Self::Agent
        } else {
            Self::Person
        }
    }

    /// Wire `deviceId` string (`"ace-cli"` or `"ace-agent"`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Person => "ace-cli",
            Self::Agent => "ace-agent",
        }
    }

    /// Corresponding [`DeviceId`].
    #[must_use]
    pub fn device_id(self) -> DeviceId {
        match self {
            Self::Person => DeviceId::local_cli(),
            Self::Agent => DeviceId::local_agent(),
        }
    }
}

/// Non-empty device identifier (`DeviceId` in `@ace/protocol`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DeviceId(String);

impl DeviceId {
    /// Parses a non-empty device id.
    pub fn parse(raw: impl Into<String>) -> Result<Self, WireError> {
        let value = raw.into();
        if value.is_empty() {
            return Err(WireError::InvalidTarget {
                detail: "Device id must not be empty".into(),
            });
        }
        Ok(Self(value))
    }

    /// The person's local CLI device id (`"ace-cli"`).
    #[must_use]
    pub fn local_cli() -> Self {
        Self("ace-cli".to_owned())
    }

    /// An agent shell's local CLI device id (`"ace-agent"`).
    #[must_use]
    pub fn local_agent() -> Self {
        Self("ace-agent".to_owned())
    }

    /// Chooses `"ace-agent"` when running inside an agent shell (`ACE_THREAD_ID` non-empty or
    /// `ACE_NO_INPUT` enabled), otherwise `"ace-cli"`, matching `person-gate.ts`.
    #[must_use]
    pub fn local_for_env(ace_thread_id: Option<&str>, ace_no_input: Option<&str>) -> Self {
        LocalIdentity::from_vars(ace_thread_id, ace_no_input).device_id()
    }

    /// Underlying string slice.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Non-empty daemon host identifier (`HostId` in `@ace/protocol`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HostId(String);

impl HostId {
    /// Parses a non-empty host id.
    pub fn parse(raw: impl Into<String>) -> Result<Self, WireError> {
        let value = raw.into();
        if value.is_empty() {
            return Err(WireError::Protocol {
                detail: "Host id must not be empty".into(),
            });
        }
        Ok(Self(value))
    }

    /// Underlying string slice.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Non-empty WebSocket request correlation identifier (`requestId`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RequestId(String);

impl RequestId {
    /// Parses a non-empty request id.
    pub fn parse(raw: impl Into<String>) -> Result<Self, WireError> {
        let value = raw.into();
        if value.is_empty() {
            return Err(WireError::Protocol {
                detail: "Request id must not be empty".into(),
            });
        }
        Ok(Self(value))
    }

    /// Underlying string slice.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Validates that `value` is 64 lowercase ASCII hex characters (`/^[0-9a-f]{64}$/`).
#[must_use]
pub fn is_hex64(value: &str) -> bool {
    value.len() == HEX64_LEN
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn decode_hex32(value: &str) -> Option<[u8; 32]> {
    if !is_hex64(value) {
        return None;
    }
    let bytes = value.as_bytes();
    let mut out = [0u8; 32];
    for (slot, pair) in out.iter_mut().zip(bytes.chunks_exact(2)) {
        let hi = hex_nibble(pair[0])?;
        let lo = hex_nibble(pair[1])?;
        *slot = (hi << 4) | lo;
    }
    Some(out)
}

const fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

/// Matches `envOn()` in `apps/daemon/src/cli/input-mode.ts`.
fn env_on(value: Option<&str>) -> bool {
    let Some(raw) = value else {
        return false;
    };
    let trimmed = raw.trim();
    !trimmed.is_empty()
        && !trimmed.eq_ignore_ascii_case("0")
        && !trimmed.eq_ignore_ascii_case("false")
        && !trimmed.eq_ignore_ascii_case("no")
}
