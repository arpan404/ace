// SPDX-License-Identifier: Apache-2.0
//! Creating a device, and folding the records an install left behind (ADR 0115,
//! `devices.ts:180`-`:274`).

use crate::devices::{
    Device, Scope, allows_scopes, hash, integer, opt_integer, opt_text, scopes_json, text,
};
use crate::error::Result;

use super::Devices;

impl Devices {
    // The seven parameters are the TypeScript's, in its order (`devices.ts:186`-`:194`).
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        name: &str,
        granted: &[Scope],
        at: i64,
        expires_at: Option<i64>,
        install_id: Option<&str>,
        person: bool,
        standing_key: Option<&str>,
    ) -> Result<(Device, String)> {
        // A device that names no standing key can never prove the person's standing, so it never
        // carries the person's bit either (ADR 0190).
        let personal = person && standing_key.is_some();
        let key = if personal { standing_key } else { None };
        let token = self.runtime.secret();
        let token_hash = hash(&token);
        let scopes_json = scopes_json(granted);
        let held = match install_id {
            Some(install) => self.by_install(install, at)?,
            None => None,
        };
        if let Some(held) = held {
            let device = Device {
                id: held.id.clone(),
                name: name.to_owned(),
                scopes: granted.to_vec(),
                created_at: held.created_at,
                last_seen_at: at,
                revoked_at: held.revoked_at,
                expires_at,
            };
            // A new credential is a new proof: the account device it was linked to is unlinked.
            self.execute(
                    "UPDATE devices SET name = ?, token_hash = ?, scopes = ?, last_seen_at = ?, \
                     expires_at = ?, person = ?, standing_key = ?, account_link = NULL WHERE id = ?",
                    &[
                        text(&device.name),
                        text(&token_hash),
                        text(&scopes_json),
                        integer(at),
                        opt_integer(device.expires_at),
                        integer(i64::from(personal)),
                        opt_text(key),
                        text(&device.id),
                    ],
                )?;
            return Ok((device, token));
        }
        // Always minted here: an install id is not a secret, so a record named by one would share
        // whatever that install's account device keeps under the same id (ADR 0115).
        let device = Device {
            id: self.runtime.id(),
            name: name.to_owned(),
            scopes: granted.to_vec(),
            created_at: at,
            last_seen_at: at,
            revoked_at: None,
            expires_at,
        };
        self.execute(
            "INSERT INTO devices (id, name, token_hash, scopes, created_at, last_seen_at, \
                 revoked_at, expires_at, install_id, person, standing_key) \
                 VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
            &[
                text(&device.id),
                text(&device.name),
                text(&token_hash),
                text(&scopes_json),
                integer(device.created_at),
                integer(device.last_seen_at),
                opt_integer(device.expires_at),
                opt_text(install_id),
                integer(i64::from(personal)),
                opt_text(key),
            ],
        )?;
        Ok((device, token))
    }

    /// `id` connected from app install `install_id`: its record learns the install, and records
    /// the install left behind before installs had ids fold into it (`devices.ts:258`–`:274`).
    pub fn recognize(&self, id: &str, install_id: &str, at: i64) -> Result<()> {
        let Some(row) = self.by_id(id)? else {
            return Ok(());
        };
        if row.revoked_at.is_some() {
            return Ok(());
        }
        if row.merged_into.is_some() {
            self.execute(
                "UPDATE devices SET merged_into = NULL WHERE id = ?",
                &[text(id)],
            )?;
        }
        if let Some(held) = row.install_id.as_deref()
            && held != install_id
        {
            return Ok(());
        }
        if row.install_id.is_none() {
            if let Some(other) = self.by_install(install_id, at)?
                && other.id != id
            {
                return Ok(());
            }
            self.execute(
                "UPDATE devices SET install_id = ? WHERE id = ?",
                &[text(install_id), text(id)],
            )?;
        }
        let survivor = row.device();
        for orphan in self.orphans(id, &row.name, row.created_at, at)? {
            let scopes = orphan.scopes.clone();
            if scopes
                .iter()
                .all(|scope| allows_scopes(&survivor.scopes, *scope))
            {
                self.execute(
                    "UPDATE devices SET merged_into = ? WHERE (id = ? OR merged_into = ?) \
                         AND revoked_at IS NULL",
                    &[text(id), text(&orphan.id), text(&orphan.id)],
                )?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::{Arc, Mutex};

    use crate::CredentialRuntime;
    use crate::devices::{Devices, Scope};

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
    fn an_install_folds_the_records_it_left_behind_only_when_the_survivor_holds_their_scopes() {
        let (devices, _home) = devices();
        // Two records from before installs had ids: same name, older, not local-only.
        let orphan = devices
            .create("Phone", &[Scope::Read], 1_000, None, None, false, None)
            .unwrap();
        let survivor = devices
            .create("Phone", &[Scope::Read], 2_000, None, None, false, None)
            .unwrap();
        // A record with a scope the survivor lacks is never folded: folding takes no access away.
        let wider = devices
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
        devices
            .recognize(&survivor.0.id, "install-0001", 3_000)
            .unwrap();
        let listed: Vec<String> = devices
            .list()
            .unwrap()
            .into_iter()
            .map(|device| device.id)
            .collect();
        assert_eq!(listed, vec![wider.0.id.clone(), survivor.0.id.clone()]);
        // A folded record used again comes back on its own.
        assert!(devices.authenticate(&orphan.1, 4_000).unwrap().is_some());
        let listed: Vec<String> = devices
            .list()
            .unwrap()
            .into_iter()
            .map(|device| device.id)
            .collect();
        assert!(listed.contains(&orphan.0.id));
    }
}
