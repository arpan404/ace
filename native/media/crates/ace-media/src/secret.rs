// SPDX-License-Identifier: Apache-2.0
//! Where ace-media keeps 32-byte secrets: the lane secret, connection tickets and ingest tokens
//! (docs/media/plan.md, "Key hand-over"). Values never get `Debug`, `Display` or `Serialize`;
//! they are compared in constant time, wiped when dropped, and kept on locked pages where the
//! OS permits (best effort).
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

pub const SECRET_LEN: usize = 32;
/// Live tickets and tokens at once. A full vault refuses the grant rather than spill a secret
/// onto an unlocked page.
pub const VAULT_SLOTS: usize = 2048;

/// One allocation of whole pages, so locking and unlocking it never touches another value.
#[repr(align(65536))]
struct Page([[u8; SECRET_LEN]; VAULT_SLOTS]);

/// Every ticket and token of the process, in one locked slab.
pub struct Vault {
    page: Box<Page>,
    locked: bool,
    free: Vec<u16>,
}

/// A slot in the [`Vault`]. It names a secret; it is not one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SecretId(u16);

impl Default for Vault {
    fn default() -> Self {
        Self::new()
    }
}

impl Vault {
    pub fn new() -> Self {
        let page = Box::new(Page([[0; SECRET_LEN]; VAULT_SLOTS]));
        let locked = media_noise::lock_memory(page.0.as_flattened());
        Self {
            page,
            locked,
            free: (0..VAULT_SLOTS as u16).rev().collect(),
        }
    }

    /// Copies `bytes` into a free slot. None when it isn't 32 bytes or the vault is full.
    pub fn store(&mut self, bytes: &[u8]) -> Option<SecretId> {
        if bytes.len() != SECRET_LEN {
            return None;
        }
        let slot = self.free.pop()?;
        self.page.0[usize::from(slot)].copy_from_slice(bytes);
        Some(SecretId(slot))
    }

    /// Wipes a slot and makes it free again.
    pub fn erase(&mut self, id: SecretId) {
        self.page.0[usize::from(id.0)].zeroize();
        self.free.push(id.0);
    }

    /// The first of `candidates` whose secret equals `presented`. Every candidate is compared,
    /// in constant time, whether or not an earlier one matched.
    pub fn find<K: Copy>(
        &self,
        candidates: impl IntoIterator<Item = (K, SecretId)>,
        presented: &[u8],
    ) -> Option<K> {
        let mut found = None;
        for (key, id) in candidates {
            let equal: bool = self.page.0[usize::from(id.0)]
                .as_slice()
                .ct_eq(presented)
                .into();
            if equal && found.is_none() {
                found = Some(key);
            }
        }
        found
    }

    pub fn live(&self) -> usize {
        VAULT_SLOTS - self.free.len()
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        self.page.0.as_flattened_mut().zeroize();
        if self.locked || cfg!(windows) {
            media_noise::unlock_memory(self.page.0.as_flattened());
        }
    }
}

/// The 32-byte lane secret from `init`'s payload, held until both socket lanes are up.
pub struct LaneSecret {
    bytes: Box<LanePage>,
    locked: bool,
}

#[repr(align(4096))]
struct LanePage([u8; SECRET_LEN]);

impl LaneSecret {
    /// Takes the secret from `init`'s payload. None unless it is exactly 32 bytes.
    pub fn from_payload(payload: &[u8]) -> Option<Self> {
        if payload.len() != SECRET_LEN {
            return None;
        }
        let mut bytes = Box::new(LanePage([0; SECRET_LEN]));
        let locked = media_noise::lock_memory(&bytes.0);
        bytes.0.copy_from_slice(payload);
        Some(Self { bytes, locked })
    }

    /// Constant-time comparison with a presented secret of any length.
    pub fn matches(&self, presented: &[u8]) -> bool {
        self.bytes.0.as_slice().ct_eq(presented).into()
    }
}

impl Drop for LaneSecret {
    fn drop(&mut self) {
        self.bytes.0.zeroize();
        if self.locked || cfg!(windows) {
            media_noise::unlock_memory(&self.bytes.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_secret_is_found_only_by_its_exact_bytes() {
        let mut vault = Vault::new();
        let a = vault.store(&[1; 32]).map(|id| ("a", id));
        let b = vault.store(&[2; 32]).map(|id| ("b", id));
        let candidates: Vec<_> = [a, b].into_iter().flatten().collect();
        assert_eq!(vault.find(candidates.clone(), &[2; 32]), Some("b"));
        assert_eq!(vault.find(candidates.clone(), &[3; 32]), None);
        assert_eq!(vault.find(candidates.clone(), &[2; 31]), None);
        let mut longer = vec![2; 32];
        longer.push(0);
        assert_eq!(vault.find(candidates, &longer), None);
    }

    #[test]
    fn an_erased_secret_no_longer_matches_and_its_slot_is_reused() {
        let mut vault = Vault::new();
        let Some(id) = vault.store(&[7; 32]) else {
            panic!("vault refused a 32-byte secret");
        };
        vault.erase(id);
        assert_eq!(vault.find([((), id)], &[7; 32]), None);
        assert_eq!(vault.live(), 0);
        assert!(vault.store(&[8; 32]).is_some());
    }

    #[test]
    fn a_full_vault_refuses_rather_than_storing_elsewhere() {
        let mut vault = Vault::new();
        for _ in 0..VAULT_SLOTS {
            assert!(vault.store(&[1; 32]).is_some());
        }
        assert!(vault.store(&[1; 32]).is_none());
        assert!(vault.store(&[1; 16]).is_none());
    }

    #[test]
    fn the_lane_secret_needs_exactly_32_bytes_and_compares_whole() {
        assert!(LaneSecret::from_payload(&[0; 31]).is_none());
        let Some(secret) = LaneSecret::from_payload(&[9; 32]) else {
            panic!("refused a 32-byte lane secret");
        };
        assert!(secret.matches(&[9; 32]));
        assert!(!secret.matches(&[9; 31]));
        let mut near = [9; 32];
        near[31] = 8;
        assert!(!secret.matches(&near));
    }
}
