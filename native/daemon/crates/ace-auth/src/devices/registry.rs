// SPDX-License-Identifier: Apache-2.0
//! Reading and updating primitives: devise records, generations, install lookups, and scope
//! changes (`devices.ts:325`-`:392`).

use std::sync::Arc;

use crate::devices::{
    COLUMNS, Device, PairedDevice, Scope, active_device, hash, integer, scopes_json, text,
};
use crate::error::Result;

use super::Devices;

impl Devices {
    pub fn get(&self, id: &str) -> Result<Option<Device>> {
        Ok(self.by_id(id)?.map(|row| row.device()))
    }

    /// The device whose record a pairing from `install_id` would take over, if any.
    pub fn held_by(&self, install_id: &str, at: i64) -> Result<Option<String>> {
        Ok(self.by_install(install_id, at)?.map(|row| row.id))
    }

    /// `id` while it is active and still holds the credential of `generation`.
    pub fn current(
        &self,
        id: &str,
        generation: Option<&str>,
        at: i64,
    ) -> Result<Option<PairedDevice>> {
        let Some(row) = self.by_id(id)? else {
            return Ok(None);
        };
        let Some(generation) = generation else {
            return Ok(None);
        };
        if row.generation() != generation || !active_device(Some(&row.device()), at) {
            return Ok(None);
        }
        Ok(Some(PairedDevice {
            device: row.device(),
            generation: generation.to_owned(),
            person: row.person,
        }))
    }

    /// The key `id` proves the person's standing with, while active, current and the person's.
    pub fn standing_key_of(
        &self,
        id: &str,
        generation: Option<&str>,
        at: i64,
    ) -> Result<Option<String>> {
        let Some(row) = self.by_id(id)? else {
            return Ok(None);
        };
        if self.current(id, generation, at)?.is_none() || !row.person {
            return Ok(None);
        }
        Ok(row.standing_key)
    }

    /// No paired device is the person's any more: the machine's owner changed (ADR 0190).
    pub fn clear_person(&self) -> Result<()> {
        self.execute(
            "UPDATE devices SET person = 0, standing_key = NULL WHERE person = 1 \
                 OR standing_key IS NOT NULL",
            &[],
        )?;
        Ok(())
    }

    /// The device a token authenticates, touching it (`devices.ts:357`).
    pub fn authenticate(&self, token: &str, at: i64) -> Result<Option<PairedDevice>> {
        let rows = self.all(
            &format!(
                "SELECT {COLUMNS} FROM devices WHERE token_hash = ? AND revoked_at IS NULL \
                     AND (expires_at IS NULL OR expires_at > ?)"
            ),
            &[text(&hash(token)), integer(at)],
        )?;
        let Some(mut row) = rows.into_iter().next() else {
            return Ok(None);
        };
        // Its own credential in use: it is a device of its own after all.
        if row.merged_into.is_some() {
            self.execute(
                "UPDATE devices SET merged_into = NULL WHERE id = ?",
                &[text(&row.id)],
            )?;
        }
        self.touch(&row.id, at)?;
        row.last_seen_at = at;
        Ok(Some(PairedDevice {
            generation: row.generation(),
            person: row.person,
            device: row.device(),
        }))
    }

    /// An ace account device connected: the paired record of the same install is seen too.
    pub fn seen(&self, install_id: &str, at: i64) -> Result<()> {
        if let Some(row) = self.by_install(install_id, at)? {
            self.touch(&row.id, at)?;
        }
        Ok(())
    }

    pub fn touch(&self, id: &str, at: i64) -> Result<()> {
        self.execute(
            "UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
            &[integer(at), text(id)],
        )?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Device>> {
        Ok(self
                .all(
                    &format!(
                        "SELECT {COLUMNS} FROM devices WHERE merged_into IS NULL ORDER BY created_at, id"
                    ),
                    &[],
                )?
                .into_iter()
                .map(|row| row.device())
                .collect())
    }

    /// Give active device `id` exactly `scopes`, keeping its credential, id and expiry.
    pub fn set_scopes(&self, id: &str, scopes: &[Scope], at: i64) -> Result<Option<Device>> {
        let Some(row) = self.by_id(id)? else {
            return Ok(None);
        };
        let held = row.device();
        if !active_device(Some(&held), at) {
            return Ok(None);
        }
        let mut seen = Vec::new();
        for scope in scopes {
            if !seen.contains(scope) {
                seen.push(*scope);
            }
        }
        let device = Device {
            scopes: seen,
            ..held
        };
        self.execute(
            "UPDATE devices SET scopes = ? WHERE id = ? AND revoked_at IS NULL",
            &[text(&scopes_json(&device.scopes)), text(&device.id)],
        )?;
        let listeners = self
            .rescoped
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect::<Vec<_>>();
        for listener in listeners {
            listener(&device.id);
        }
        Ok(Some(device))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::{Arc, Mutex};

    use crate::CredentialRuntime;
    use crate::devices::row::generation_of;
    use crate::devices::{Devices, Scope, active_device, hash};

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

    #[test]
    fn a_credential_generation_names_the_token_and_a_rekey_ends_the_old_one() {
        let (devices, _home) = devices();
        let first = devices
            .create(
                "Phone",
                &[Scope::Read],
                1_000,
                None,
                Some("install-0001"),
                false,
                None,
            )
            .unwrap();
        let generation = devices
            .authenticate(&first.1, 1_000)
            .unwrap()
            .unwrap()
            .generation;
        assert_eq!(generation, generation_of(&hash(&first.1)));
        assert!(
            devices
                .current(&first.0.id, Some(&generation), 1_000)
                .unwrap()
                .is_some()
        );
        assert!(
            devices
                .current(&first.0.id, Some("someone-else"), 1_000)
                .unwrap()
                .is_none()
        );
        let again = devices
            .create(
                "Phone",
                &[Scope::Read, Scope::Operate],
                2_000,
                None,
                Some("install-0001"),
                false,
                None,
            )
            .unwrap();
        assert_eq!(again.0.id, first.0.id);
        assert!(devices.authenticate(&first.1, 2_000).unwrap().is_none());
        assert!(
            devices
                .current(&first.0.id, Some(&generation), 2_000)
                .unwrap()
                .is_none()
        );
        assert!(devices.authenticate(&again.1, 2_000).unwrap().is_some());
    }

    #[test]
    fn expiry_is_not_revocation_and_scope_changes_keep_the_credential() {
        let (devices, _home) = devices();
        let device = devices
            .create(
                "Phone",
                &[Scope::Read],
                1_000,
                Some(2_000),
                None,
                false,
                None,
            )
            .unwrap();
        assert!(active_device(Some(&device.0), 1_999));
        assert!(!active_device(Some(&device.0), 2_000));
        let listed = devices.list().unwrap();
        assert_eq!(listed[0].revoked_at, None);
        let changed = devices
            .set_scopes(
                &device.0.id,
                &[Scope::Read, Scope::Read, Scope::Operate],
                1_500,
            )
            .unwrap()
            .unwrap();
        assert_eq!(changed.scopes, vec![Scope::Read, Scope::Operate]);
        assert!(devices.authenticate(&device.1, 1_500).unwrap().is_some());
        // After expiry the credential authenticates nothing, but the row is not revoked.
        assert!(devices.authenticate(&device.1, 2_000).unwrap().is_none());
    }
}
