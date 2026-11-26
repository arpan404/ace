// SPDX-License-Identifier: Apache-2.0
//! Device administration on `RemoteAuth` (`remote-auth.ts:162`-`:175`, `:236`-`:311`): an account
//! device seen, a paired device's install recognised, the listing, scope changes, revoking a
//! device or every other one.

use crate::devices::{Device, PairingLinkProof, Scope, active_device};
use crate::error::{AuthError, Result};
use crate::remote_auth::{RemoteAuth, local_only, not_paired};

impl RemoteAuth {
    pub fn account_device_seen(
        &mut self,
        device_id: &str,
        link: Option<&PairingLinkProof>,
    ) -> Result<()> {
        self.devices.seen(device_id, self.now())?;
        if let Some(link) = link {
            self.devices.link(device_id, link, self.now())?;
        }
        Ok(())
    }

    /// A paired device's hello named its app install: its records fold into one (ADR 0115).
    pub fn recognize(&mut self, device: &Device, install_id: Option<&str>) -> Result<()> {
        if let Some(install) = install_id {
            self.devices.recognize(&device.id, install, self.now())?;
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Device>> {
        self.devices.list()
    }

    /// Allow or stop allowing `scope` for paired device `id`, keeping its credential.
    pub fn set_scope(&mut self, id: &str, scope: Scope, allowed: bool) -> Result<Device> {
        let at = self.now();
        let device = self.devices.get(id)?;
        let Some(device) = device else {
            return Err(not_paired());
        };
        if device.revoked_at.is_some() || !active_device(Some(&device), at) {
            return Err(not_paired());
        }
        if local_only(&device) || !scope.pairable() {
            return Err(AuthError::access(
                403,
                "This machine's own credentials can't change here.",
            ));
        }
        let mut scopes = device.scopes.clone();
        if allowed {
            if !scopes.contains(&scope) {
                scopes.push(scope);
            }
        } else {
            scopes.retain(|each| *each != scope);
        }
        if scopes.is_empty() {
            return Err(AuthError::access(
                400,
                "A device keeps at least one kind of access. Remove it instead.",
            ));
        }
        self.devices
            .set_scopes(id, &scopes, at)?
            .ok_or_else(not_paired)
    }

    /// Revoke `id` and every record folded into it (ADR 0115).
    pub fn revoke(&mut self, id: &str) -> Result<bool> {
        let revoked = self.devices.revoke_install(id, self.now())?;
        for each in &revoked {
            self.tickets.revoke(each);
            for listener in self.listeners(&self.revoked) {
                listener(each);
            }
        }
        Ok(!revoked.is_empty())
    }

    /// Revoke every paired device but `keep` and the daemon's local credentials.
    pub fn revoke_others(&mut self, keep: Option<&str>) -> Result<usize> {
        let mut count = 0;
        for device in self.devices.list()? {
            if Some(device.id.as_str()) != keep
                && device.revoked_at.is_none()
                && !local_only(&device)
                && self.revoke(&device.id)?
            {
                count += 1;
            }
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    //! Ported cases live beside the methods they prove; see each file's header for its
    //! TypeScript source.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::{Arc, Mutex};

    use crate::devices::Scope;
    use crate::pairing::PairingTerms;
    use crate::remote_auth::support::{Home, pair_with};

    #[test]
    fn a_fabricated_token_authenticates_nothing_and_redemption_ignores_scope_injection() {
        let home = Home::new();
        let mut auth = home.memory();
        assert!(auth.device_bearer(&"b".repeat(64)).is_none());
        let issued = auth
            .pairing(&[Scope::Read], &PairingTerms::default())
            .unwrap();
        // The redemption body names only code, name, install id and standing key: a `scopes`
        // field is not part of it, so the link's own scopes stand.
        let redeemed = auth.redeem(&issued.code, "Phone", None, None).unwrap();
        assert_eq!(redeemed.device.scopes, vec![Scope::Read]);
        // An unknown scope is not a PairingRequest.
        let request = ace_json::parse("{\"scopes\":[\"root\"]}").unwrap();
        assert!(crate::pairing::PairingRequest::parse(&request).is_none());
    }

    #[test]
    fn a_device_that_pairs_its_install_again_keeps_its_record_and_replaces_its_credential() {
        let home = Home::new();
        let mut auth = home.memory();
        let first = pair_with(
            &mut auth,
            &[Scope::Read],
            "Phone",
            Some("install-0001"),
            None,
        );
        let replaced = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&replaced);
        auth.on_credential_replaced(Arc::new(move |id: &str| {
            recorded.lock().unwrap().push(id.to_owned())
        }))
        .unwrap();
        let old_ticket = auth
            .ticket(&auth.device_bearer(&first.token).unwrap(), "")
            .unwrap();
        let again = pair_with(
            &mut auth,
            &[Scope::Read, Scope::Operate],
            "Phone",
            Some("install-0001"),
            None,
        );
        assert_eq!(again.device.id, first.device.id);
        assert_eq!(again.device.scopes, vec![Scope::Read, Scope::Operate]);
        assert_eq!(*replaced.lock().unwrap(), vec![first.device.id.clone()]);
        // The old credential stops working, and its ticket with it.
        assert!(auth.device_bearer(&first.token).is_none());
        assert!(auth.consume(&old_ticket.ticket).is_none());
    }

    #[test]
    fn a_device_paired_for_a_day_loses_access_after_it_and_is_listed_as_expired_not_revoked() {
        let home = Home::new();
        let mut auth = home.memory();
        let day = 86_400_000;
        let issued = auth
            .pairing(
                &[Scope::Read],
                &PairingTerms {
                    device_ttl_ms: Some(day),
                    ..Default::default()
                },
            )
            .unwrap();
        let paired = auth.redeem(&issued.code, "Laptop", None, None).unwrap();
        assert_eq!(paired.device.expires_at, Some(1_000_000 + day));
        assert!(auth.device_bearer(&paired.token).is_some());
        home.advance(day + 1);
        assert!(auth.device_bearer(&paired.token).is_none());
        let listed = auth.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].revoked_at, None);
        assert_eq!(listed[0].expires_at, Some(1_000_000 + day));
    }

    #[test]
    fn revoking_every_other_device_spares_the_callers_own_and_ends_the_tickets() {
        let home = Home::new();
        let mut auth = home.memory();
        let phone = pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let tablet = pair_with(&mut auth, &[Scope::Read], "Tablet", None, None);
        let mine = pair_with(&mut auth, &[Scope::Admin], "This", None, None);
        assert_eq!(auth.revoke_others(Some(&mine.device.id)).unwrap(), 2);
        assert!(auth.device_bearer(&phone.token).is_none());
        assert!(auth.device_bearer(&tablet.token).is_none());
        assert!(auth.device_bearer(&mine.token).is_some());
    }

    #[test]
    fn an_administrator_allows_a_scope_a_paired_device_holds_and_it_keeps_its_credential() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(
            &mut auth,
            &[Scope::Read, Scope::Operate],
            "Phone",
            None,
            None,
        );
        let changed = auth
            .set_scope(&paired.device.id, Scope::Projects, true)
            .unwrap();
        assert_eq!(
            changed.scopes,
            vec![Scope::Read, Scope::Operate, Scope::Projects]
        );
        assert!(auth.device_bearer(&paired.token).is_some());
        // Removing its last scope is Remove, not a change.
        let changed = auth
            .set_scope(&paired.device.id, Scope::Projects, false)
            .unwrap();
        assert_eq!(changed.scopes, vec![Scope::Read, Scope::Operate]);
        auth.set_scope(&paired.device.id, Scope::Operate, false)
            .unwrap();
        let error = auth
            .set_scope(&paired.device.id, Scope::Read, false)
            .unwrap_err();
        assert_eq!(
            error.message(),
            "A device keeps at least one kind of access. Remove it instead."
        );
        let error = auth.set_scope("missing", Scope::Read, true).unwrap_err();
        assert_eq!(error.message(), "That device isn't paired anymore.");
    }
}
