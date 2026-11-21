//! The org host's audit key (ADR 0206 §4.2): an Ed25519 key made on the host, its seed kept in
//! the host's keychain (`spade-keys`, account `org-audit:<org>`), its public half registered with
//! the backend at enrollment (`org_hosts.audit_key`). It signs the log's checkpoints; nothing
//! else, and it never leaves the host.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use spade_core::org::audit;

/// A host's audit key, loaded.
pub struct AuditKey {
    pair: Ed25519KeyPair,
}

impl AuditKey {
    /// The key whose seed is `seed`.
    pub fn from_seed(seed: &[u8; 32]) -> Option<Self> {
        // Only a seed of another length is refused.
        Ed25519KeyPair::from_seed_unchecked(seed)
            .ok()
            .map(|pair| Self { pair })
    }

    /// The seed as the keychain keeps it: hex.
    fn from_hex(text: &str) -> Option<Self> {
        let text = text.trim();
        if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let mut seed = [0u8; 32];
        for (at, byte) in seed.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&text[at * 2..at * 2 + 2], 16).ok()?;
        }
        Self::from_seed(&seed)
    }

    /// Its public half, base64url, as enrollment registers it.
    pub fn public(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.pair.public_key().as_ref())
    }

    /// The signature over `message`, base64url.
    pub fn sign(&self, message: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(self.pair.sign(message).as_ref())
    }

    /// Signs a checkpoint over entry `count` at `head`.
    pub fn checkpoint(
        &self,
        org: &str,
        host: &str,
        count: i64,
        head: &str,
        at: i64,
    ) -> audit::Checkpoint {
        let message = audit::checkpoint_message(org, host, count, head, at);
        audit::Checkpoint {
            count,
            head: head.to_owned(),
            at,
            signature: self.sign(&message),
        }
    }
}

/// Whether `signature` (base64url) is `public`'s (base64url) over `message`: what
/// `ace org audit verify` checks each checkpoint with, offline.
pub fn signed_by(public: &str, message: &[u8], signature: &str) -> bool {
    let (Ok(public), Ok(signature)) = (
        URL_SAFE_NO_PAD.decode(public.trim()),
        URL_SAFE_NO_PAD.decode(signature),
    ) else {
        return false;
    };
    UnparsedPublicKey::new(&ED25519, &public)
        .verify(message, &signature)
        .is_ok()
}

/// The audit key for `org` in `keychain`, made now from `fresh` (32 random bytes) when it has
/// none. The error says why the host can't sign its log.
pub fn load_or_make(
    keychain: &spade_keys::KeyStore,
    org: &str,
    fresh: impl FnOnce() -> Result<[u8; 32], String>,
) -> Result<AuditKey, String> {
    if let Some(seed) = keychain.audit_key(org).map_err(|e| e.to_string())? {
        return AuditKey::from_hex(&seed)
            .ok_or_else(|| "the audit key in the keychain isn't one".to_owned());
    }
    let seed = fresh()?;
    let hex: String = seed.iter().map(|b| format!("{b:02x}")).collect();
    keychain
        .set_audit_key(org, &hex)
        .map_err(|e| e.to_string())?;
    AuditKey::from_seed(&seed).ok_or_else(|| "a new audit key couldn't be made".to_owned())
}

/// 32 bytes from the operating system's random source, for a new key.
pub fn os_seed() -> Result<[u8; 32], String> {
    let mut seed = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut seed)
        .map_err(|_| "the operating system's random source failed".to_owned())?;
    Ok(seed)
}
