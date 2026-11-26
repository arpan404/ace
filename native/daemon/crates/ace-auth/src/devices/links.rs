// SPDX-License-Identifier: Apache-2.0
//! What one device is, for command receipts (ADR 0115, `devices.ts:275`-`:324`): the proof an
//! account device makes with a paired credential, and the ids that fold into one.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::devices::{PairingLinkProof, Scope, active_device, integer, text};
use crate::error::{AuthError, Result};

use super::Devices;

impl Devices {
    /// The ace account device `account_id` proved it holds the credential of paired record
    /// `link.device_id` (ADR 0115). False when the proof doesn't match an active paired
    /// credential; local-only credentials never link (`devices.ts:282`–`:296`).
    pub fn link(&self, account_id: &str, link: &PairingLinkProof, at: i64) -> Result<bool> {
        let Some(row) = self.by_id(&link.device_id)? else {
            return Ok(false);
        };
        if link.device_id == account_id || !active_device(Some(&row.device()), at) {
            return Ok(false);
        }
        if row
            .scopes
            .iter()
            .any(|scope| matches!(scope, Scope::Desktop | Scope::UserBrowser))
        {
            return Ok(false);
        }
        let mut mac =
            <Hmac<Sha256> as hmac::digest::KeyInit>::new_from_slice(row.token_hash.as_bytes())
                .map_err(|error| AuthError::Token(error.to_string()))?;
        mac.update(format!("ace-link/v1\n{}\n{}", link.device_id, account_id).as_bytes());
        let expected = mac.finalize().into_bytes();
        let Ok(given) = base64::Engine::decode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            link.proof.as_bytes(),
        ) else {
            return Ok(false);
        };
        if given.len() != expected.len() || !bool::from(given.ct_eq(expected.as_slice())) {
            return Ok(false);
        }
        self.execute(
            "UPDATE devices SET account_link = ? WHERE id = ?",
            &[text(account_id), text(&link.device_id)],
        )?;
        // The hello that proved it is the pairing's use, so the linked-id cap drops it last.
        self.touch(&link.device_id, at)?;
        Ok(true)
    }

    /// Whether `a` and `b` are one device for command receipts (`devices.ts:303`–`:311`).
    pub fn same_install(&self, a: &str, b: &str) -> Result<bool> {
        if a == b {
            return Ok(true);
        }
        let proven = |id: &str| -> Result<Option<String>> {
            Ok(match self.by_id(id)? {
                Some(row) => row.account_link,
                None => Some(id.to_owned()),
            })
        };
        let left = proven(a)?;
        Ok(left.is_some() && left == proven(b)?)
    }

    /// The other ids `id` is one device with, most recently seen first (`devices.ts:316`).
    pub fn linked(&self, id: &str, at: i64) -> Result<Vec<String>> {
        let row = self.by_id(id)?;
        if let Some(row) = &row
            && !active_device(Some(&row.device()), at)
        {
            return Ok(Vec::new());
        }
        let account = match row {
            Some(row) => row.account_link,
            None => Some(id.to_owned()),
        };
        let Some(account) = account else {
            return Ok(Vec::new());
        };
        let linked = self.ids(
            "SELECT id FROM devices WHERE account_link = ? AND revoked_at IS NULL \
                 AND (expires_at IS NULL OR expires_at > ?) ORDER BY last_seen_at DESC, id",
            &[text(&account), integer(at)],
        )?;
        if linked.is_empty() {
            return Ok(Vec::new());
        }
        let mut ids = vec![account];
        ids.extend(linked);
        Ok(ids.into_iter().filter(|other| other != id).collect())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::{Arc, Mutex};

    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    use crate::CredentialRuntime;
    use crate::devices::{Devices, PairingLinkProof, Scope, hash};

    const ACCOUNT: &str = "account-phone";
    /// `linkedLimit` (`@ace/notify`'s `worker-wire.ts:17`).
    const LINKED_LIMIT: usize = 16;

    fn devices() -> (Devices, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let counter = Arc::new(Mutex::new(0_u64));
        let entropy = Arc::new(Mutex::new(0_u64));
        let runtime = CredentialRuntime::new(
            move || {
                let mut id = counter.lock().unwrap();
                *id += 1;
                format!("device-{id}")
            },
            move |size| {
                let mut seed = entropy.lock().unwrap();
                *seed += 1;
                let mut bytes = vec![7_u8; size];
                let width = size.min(8);
                bytes[..width].copy_from_slice(&seed.to_be_bytes()[8 - width..]);
                bytes
            },
        );
        let path = directory.path().join("events.sqlite");
        let devices = Devices::open(path.to_str().unwrap(), runtime).unwrap();
        (devices, directory)
    }

    /// `pairingLinkProof`: base64url HMAC-SHA256 keyed by the token's SHA-256.
    fn proof(token: &str, device_id: &str, account: &str) -> PairingLinkProof {
        let mut mac =
            <Hmac<Sha256> as hmac::digest::KeyInit>::new_from_slice(hash(token).as_bytes())
                .unwrap();
        mac.update(format!("ace-link/v1\n{device_id}\n{account}").as_bytes());
        PairingLinkProof {
            device_id: device_id.to_owned(),
            proof: base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                mac.finalize().into_bytes(),
            ),
        }
    }

    fn cap_linked(linked: Vec<String>, limit: usize) -> (Vec<String>, usize) {
        let cut = linked.len().saturating_sub(limit);
        (linked.into_iter().take(limit).collect(), cut)
    }

    #[test]
    fn a_pairing_and_the_account_device_that_proved_it_list_each_other_as_the_same_device() {
        let (devices, _home) = devices();
        let paired = devices
            .create(
                "Phone",
                &[Scope::Read, Scope::Operate],
                1_000,
                None,
                None,
                false,
                None,
            )
            .unwrap();
        let other = devices
            .create("Laptop", &[Scope::Read], 1_000, None, None, false, None)
            .unwrap();
        let proof = proof(&paired.1, &paired.0.id, ACCOUNT);
        assert!(devices.linked(ACCOUNT, 1_000).unwrap().is_empty());
        assert!(devices.link(ACCOUNT, &proof, 1_000).unwrap());
        assert_eq!(
            devices.linked(ACCOUNT, 1_000).unwrap(),
            vec![paired.0.id.clone()]
        );
        assert_eq!(
            devices.linked(&paired.0.id, 1_000).unwrap(),
            vec![ACCOUNT.to_owned()]
        );
        assert!(devices.linked(&other.0.id, 1_000).unwrap().is_empty());
        assert!(devices.same_install(ACCOUNT, &paired.0.id).unwrap());
        assert!(!devices.same_install(&other.0.id, &paired.0.id).unwrap());
    }

    #[test]
    fn a_revoked_pairing_is_nobodys_other_id() {
        let (devices, _home) = devices();
        let paired = devices
            .create(
                "Phone",
                &[Scope::Read, Scope::Operate],
                1_000,
                None,
                None,
                false,
                None,
            )
            .unwrap();
        let proof = proof(&paired.1, &paired.0.id, ACCOUNT);
        assert!(devices.link(ACCOUNT, &proof, 1_000).unwrap());
        assert!(devices.revoke(&paired.0.id, 2_000).unwrap());
        assert!(devices.linked(ACCOUNT, 3_000).unwrap().is_empty());
        assert!(devices.linked(&paired.0.id, 3_000).unwrap().is_empty());
    }

    #[test]
    fn the_pairing_a_phone_used_most_recently_survives_the_cap_on_linked_ids() {
        let (devices, _home) = devices();
        let mut pairings = Vec::new();
        for index in 0..LINKED_LIMIT + 4 {
            let paired = devices
                .create(
                    &format!("Phone {index}"),
                    &[Scope::Read],
                    1_000 + index as i64,
                    None,
                    None,
                    false,
                    None,
                )
                .unwrap();
            let proof = proof(&paired.1, &paired.0.id, ACCOUNT);
            assert!(devices.link(ACCOUNT, &proof, 1_000 + index as i64).unwrap());
            pairings.push(paired.0.id);
        }
        // Sorted by id this one would be cut; it was seen last, so it stays.
        let mut sorted = pairings.clone();
        sorted.sort();
        let last_used = sorted.last().unwrap().clone();
        devices.touch(&last_used, 5_000).unwrap();
        let linked = devices.linked(&pairings[0], 6_000).unwrap();
        assert_eq!(linked[0], ACCOUNT);
        let (kept, cut) = cap_linked(devices.linked(ACCOUNT, 6_000).unwrap(), LINKED_LIMIT);
        assert_eq!(kept.len(), LINKED_LIMIT);
        assert_eq!(kept[0], last_used);
        assert_eq!(cut, 4);
    }

    #[test]
    fn an_account_hello_that_proves_a_pairing_counts_as_that_pairings_use() {
        let (devices, _home) = devices();
        let registering = devices
            .create("Phone", &[Scope::Read], 1_000, None, None, false, None)
            .unwrap();
        let registering_proof = proof(&registering.1, &registering.0.id, ACCOUNT);
        assert!(devices.link(ACCOUNT, &registering_proof, 1_000).unwrap());
        for index in 0..LINKED_LIMIT + 2 {
            let other = devices
                .create(
                    &format!("Other {index}"),
                    &[Scope::Read],
                    2_000 + index as i64,
                    None,
                    None,
                    false,
                    None,
                )
                .unwrap();
            let other_proof = proof(&other.1, &other.0.id, ACCOUNT);
            assert!(
                devices
                    .link(ACCOUNT, &other_proof, 2_000 + index as i64)
                    .unwrap()
            );
        }
        // Its hello again, after all of them.
        assert!(devices.link(ACCOUNT, &registering_proof, 9_000).unwrap());
        let (kept, _) = cap_linked(devices.linked(ACCOUNT, 9_500).unwrap(), LINKED_LIMIT);
        assert_eq!(kept[0], registering.0.id);
    }

    #[test]
    fn a_link_proof_that_does_not_match_links_nothing() {
        let (devices, _home) = devices();
        let paired = devices
            .create("Phone", &[Scope::Read], 1_000, None, None, false, None)
            .unwrap();
        let mut wrong = proof(&paired.1, &paired.0.id, ACCOUNT);
        wrong.proof = "A".repeat(43);
        assert!(!devices.link(ACCOUNT, &wrong, 1_000).unwrap());
        // The same device can't prove itself an account device.
        let own = proof(&paired.1, &paired.0.id, &paired.0.id);
        assert!(!devices.link(&paired.0.id, &own, 1_000).unwrap());
    }
}
