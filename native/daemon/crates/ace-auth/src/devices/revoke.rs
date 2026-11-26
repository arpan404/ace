// SPDX-License-Identifier: Apache-2.0
//! Revocation (`devices.ts:353`-`:418`): a record and the records folded into it, each listener
//! told so its sockets, tickets and channels close.

use std::sync::Arc;

use crate::devices::{integer, text};
use crate::error::Result;

use super::Devices;

impl Devices {
    pub fn revoke(&self, id: &str, at: i64) -> Result<bool> {
        Ok(!self.revoke_install(id, at)?.is_empty())
    }

    /// Revoke `id` and the records folded into it, `id` first; empty when it was not active
    /// (`devices.ts:401`–`:409`).
    pub fn revoke_install(&self, id: &str, at: i64) -> Result<Vec<String>> {
        let folded = self.ids(
            "SELECT id FROM devices WHERE merged_into = ? AND revoked_at IS NULL ORDER BY id",
            &[text(id)],
        )?;
        if self.changed(
            "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            &[integer(at), text(id)],
        )? == 0
        {
            return Ok(Vec::new());
        }
        let mut revoked = vec![id.to_owned()];
        for other in folded {
            if self.changed(
                "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
                &[integer(at), text(&other)],
            )? > 0
            {
                revoked.push(other);
            }
        }
        let listeners = self
            .revoked
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect::<Vec<_>>();
        for each in &revoked {
            for listener in &listeners {
                listener(each);
            }
        }
        Ok(revoked)
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
    fn revoking_a_device_revokes_the_records_folded_into_it_and_tells_each_listener() {
        let (devices, _home) = devices();
        let survivor = devices
            .create("Phone", &[Scope::Read], 1_000, None, None, false, None)
            .unwrap();
        devices
            .recognize(&survivor.0.id, "install-0001", 2_000)
            .unwrap();
        let heard = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&heard);
        devices
            .on_revoke(Arc::new(move |id: &str| {
                recorder.lock().unwrap().push(id.to_owned())
            }))
            .unwrap();
        assert_eq!(
            devices.revoke_install(&survivor.0.id, 3_000).unwrap(),
            vec![survivor.0.id.clone()]
        );
        assert_eq!(*heard.lock().unwrap(), vec![survivor.0.id.clone()]);
        assert!(
            devices
                .revoke_install(&survivor.0.id, 4_000)
                .unwrap()
                .is_empty()
        );
    }
}
