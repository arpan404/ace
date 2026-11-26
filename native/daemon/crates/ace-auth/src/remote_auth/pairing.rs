// SPDX-License-Identifier: Apache-2.0
//! Pairing links on `RemoteAuth` (`remote-auth.ts:86`-`:160`, `:313`-`:319`): issuing a single-use
//! code under the caps, listing and cancelling links, the redemption rate limit, and the redeem
//! that rekeys an install's one record.

use crate::devices::{Scope, hash};
use crate::error::{AuthError, Result};
use crate::pairing::{PairingTerms, PendingCode, PendingPairing, scope_label as scope_name};
use crate::remote_auth::{Attempt, PairingTicket, RedeemedDevice, RemoteAuth};

impl RemoteAuth {
    pub fn pairing(&mut self, granted: &[Scope], terms: &PairingTerms) -> Result<PairingTicket> {
        if granted.iter().any(|scope| !scope.pairable()) {
            return Err(AuthError::access(403, "Desktop credentials are local only"));
        }
        if self.codes.pending(self.now())?.len() >= 100 {
            return Err(AuthError::access(429, "Too many pending pairings"));
        }
        let code = self.runtime.secret();
        let id = self.runtime.id();
        let time = self.now();
        let expires_at = time + terms.ttl_ms.unwrap_or(300_000);
        self.codes.put(
            &hash(&code),
            &PendingCode {
                id: id.clone(),
                expires_at,
                scopes: granted.to_vec(),
                label: terms.label.clone().filter(|label| !label.is_empty()),
                device_ttl_ms: terms.device_ttl_ms.filter(|ttl| *ttl != 0),
                person: terms.person,
            },
        )?;
        Ok(PairingTicket {
            id,
            code,
            expires_at,
        })
    }

    /// Links not yet redeemed or expired, oldest first. Never their codes.
    pub fn pending_pairings(&mut self) -> Result<Vec<PendingPairing>> {
        Ok(self
            .codes
            .pending(self.now())?
            .iter()
            .map(PendingPairing::from)
            .collect())
    }

    /// The machine's owner changed (ADR 0190): no paired device is the person's, and no link a
    /// person made can still be redeemed. The devices stay paired, with their other access.
    pub fn drop_person_standing(&mut self) -> Result<()> {
        self.devices.clear_person()?;
        for pending in self.codes.pending(self.now())? {
            if pending.person {
                self.codes.remove(&pending.id)?;
            }
        }
        Ok(())
    }

    /// False when no pending link has that id.
    pub fn cancel_pairing(&mut self, id: &str) -> Result<bool> {
        self.codes.remove(id)
    }

    pub fn pairing_attempt(&mut self, address: &str) -> Result<()> {
        self.limit(address)?;
        self.limit("*")
    }

    /// Redeem a pairing; the same app install keeps its one record (ADR 0115).
    pub fn redeem(
        &mut self,
        code: &str,
        name: &str,
        install_id: Option<&str>,
        standing_key: Option<&str>,
    ) -> Result<RedeemedDevice> {
        let pairing = self.codes.take(&hash(code))?;
        let Some(pairing) = pairing else {
            return Err(AuthError::access(401, "Invalid or expired pairing code"));
        };
        let at = self.now();
        if pairing.expires_at <= at {
            return Err(AuthError::access(401, "Invalid or expired pairing code"));
        }
        let held = match install_id {
            Some(install) => self.devices.held_by(install, at)?,
            None => None,
        };
        let (device, token) = self.devices.create(
            pairing.label.as_deref().unwrap_or(name),
            &pairing.scopes,
            at,
            pairing.device_ttl_ms.map(|ttl| at + ttl),
            install_id,
            pairing.person,
            standing_key,
        )?;
        // The install's record got a new credential and scopes: what the old one opened ends.
        if let Some(held) = held {
            self.tickets.revoke(&held);
            for listener in self.listeners(&self.replaced) {
                listener(&held);
            }
        }
        Ok(RedeemedDevice { device, token })
    }

    /// An ace account device was admitted: its account device id is its install id (ADR 0115).
    fn limit(&mut self, address: &str) -> Result<()> {
        let now = self.now();
        self.attempts.retain(|_, entry| entry.resets_at > now);
        let cap = if address == "*" { 100 } else { 5 };
        let over_global = self.attempts.len() >= 10_000;
        match self.attempts.get_mut(address) {
            Some(entry) => {
                entry.count += 1;
                if over_global || entry.count > cap {
                    return Err(AuthError::access(429, "Pairing rate limit exceeded"));
                }
            }
            None => {
                if over_global || 1 > cap {
                    return Err(AuthError::access(429, "Pairing rate limit exceeded"));
                }
                self.attempts.insert(
                    address.to_owned(),
                    Attempt {
                        count: 1,
                        resets_at: now + 60_000,
                    },
                );
            }
        }
        Ok(())
    }

    /// The scopes a pairing link may grant, for a refusal that names the first missing one.
    pub fn missing_scope(granted: &[Scope], holds: impl Fn(Scope) -> bool) -> Option<Scope> {
        granted.iter().copied().find(|scope| !holds(*scope))
    }

    /// The scope names a refusal quotes (`pairing-issue.ts:26`).
    pub fn scope_label(scope: Scope) -> &'static str {
        scope_name(scope)
    }
}

#[cfg(test)]
mod tests {
    //! Ported cases live beside the methods they prove; see each file's header for its
    //! TypeScript source.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use crate::devices::Scope;
    use crate::pairing::PairingTerms;
    use crate::remote_auth::support::Home;

    #[test]
    fn a_pairing_link_issued_before_a_restart_still_pairs_once_afterwards() {
        let home = Home::new();
        let issued = home
            .start()
            .pairing(
                &[Scope::Read, Scope::Operate],
                &PairingTerms {
                    label: Some("Phone".to_owned()),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut restarted = home.start();
        assert_eq!(
            restarted
                .pending_pairings()
                .unwrap()
                .iter()
                .map(|code| code.id.clone())
                .collect::<Vec<_>>(),
            vec![issued.id.clone()]
        );
        let paired = restarted
            .redeem(&issued.code, "ignored", None, None)
            .unwrap();
        assert_eq!(paired.device.name, "Phone");
        assert_eq!(paired.device.scopes, vec![Scope::Read, Scope::Operate]);
        // Single use, across restarts too.
        let error = home
            .start()
            .redeem(&issued.code, "Second", None, None)
            .unwrap_err();
        assert_eq!(error.message(), "Invalid or expired pairing code");
    }

    #[test]
    fn a_link_still_ends_at_its_own_expiry_across_a_restart() {
        let home = Home::new();
        let issued = home
            .start()
            .pairing(
                &[Scope::Read],
                &PairingTerms {
                    ttl_ms: Some(60_000),
                    ..Default::default()
                },
            )
            .unwrap();
        home.advance(60_000);
        let mut restarted = home.start();
        assert!(restarted.pending_pairings().unwrap().is_empty());
        assert_eq!(
            restarted
                .redeem(&issued.code, "Phone", None, None)
                .unwrap_err()
                .message(),
            "Invalid or expired pairing code"
        );
    }

    #[test]
    fn the_database_holds_only_the_codes_hash_and_a_cancelled_link_pairs_nothing() {
        let home = Home::new();
        let mut auth = home.start();
        let kept = auth
            .pairing(&[Scope::Read], &PairingTerms::default())
            .unwrap();
        let cancelled = auth
            .pairing(&[Scope::Read], &PairingTerms::default())
            .unwrap();
        let conn = auth.devices().connection().clone();
        let statement = conn
            .prepare("SELECT code_hash, id, label FROM pairing_codes")
            .unwrap();
        let mut stored = String::new();
        while let Some(values) = statement.step().unwrap() {
            stored.push_str(&format!("{values:?}"));
        }
        assert!(!stored.contains(&kept.code), "{stored}");
        assert!(auth.cancel_pairing(&cancelled.id).unwrap());
        let mut restarted = home.start();
        assert_eq!(
            restarted
                .redeem(&cancelled.code, "Phone", None, None)
                .unwrap_err()
                .message(),
            "Invalid or expired pairing code"
        );
        assert_eq!(
            restarted
                .redeem(&kept.code, "Phone", None, None)
                .unwrap()
                .device
                .scopes,
            vec![Scope::Read]
        );
    }

    #[test]
    fn redemption_attempts_are_limited_per_address_and_globally_and_reset_after_a_minute() {
        let home = Home::new();
        let mut auth = home.memory();
        // Five attempts per source address, 100 overall: 100 attempts from 20 addresses pass.
        for attempt in 0..100 {
            auth.pairing_attempt(&format!("source-{}", attempt / 5))
                .expect("inside both windows");
        }
        let error = auth
            .pairing_attempt("source-20")
            .expect_err("the global budget is spent");
        assert_eq!(error.status(), 429);
        assert_eq!(error.message(), "Pairing rate limit exceeded");
        home.advance(60_000);
        auth.pairing_attempt("source-20")
            .expect("the window resets after a minute");
    }

    #[test]
    fn open_links_are_listed_without_codes_and_a_cancelled_one_no_longer_pairs() {
        let home = Home::new();
        let mut auth = home.memory();
        let kept = auth
            .pairing(
                &[Scope::Read],
                &PairingTerms {
                    label: Some("Phone".to_owned()),
                    ..Default::default()
                },
            )
            .unwrap();
        let cancelled = auth
            .pairing(
                &[Scope::Read, Scope::Operate],
                &PairingTerms {
                    device_ttl_ms: Some(604_800_000),
                    ..Default::default()
                },
            )
            .unwrap();
        let listed = auth.pending_pairings().unwrap();
        assert_eq!(listed.len(), 2);
        let text = format!("{listed:?}");
        assert!(!text.contains(&kept.code));
        assert!(!text.contains(&cancelled.code));
        assert_eq!(
            listed
                .iter()
                .find(|each| each.id == kept.id)
                .unwrap()
                .label
                .as_deref(),
            Some("Phone")
        );
        assert!(auth.cancel_pairing(&cancelled.id).unwrap());
        assert_eq!(
            auth.redeem(&cancelled.code, "Phone", None, None)
                .unwrap_err()
                .message(),
            "Invalid or expired pairing code"
        );
        assert!(!auth.cancel_pairing(&cancelled.id).unwrap());
        assert_eq!(auth.pending_pairings().unwrap().len(), 1);
    }

    #[test]
    fn dropping_person_standing_unpersons_devices_and_ends_person_links() {
        let home = Home::new();
        let mut auth = home.memory();
        let personal = auth
            .pairing(
                &[Scope::Read],
                &PairingTerms {
                    person: true,
                    ..Default::default()
                },
            )
            .unwrap();
        let ordinary = auth
            .pairing(&[Scope::Read], &PairingTerms::default())
            .unwrap();
        let device = auth
            .redeem(&personal.code, "Phone", None, Some(&"A".repeat(43)))
            .unwrap();
        assert!(auth.device_bearer(&device.token).is_some());
        let personal_pending = auth
            .pairing(
                &[Scope::Read],
                &PairingTerms {
                    person: true,
                    ..Default::default()
                },
            )
            .unwrap();
        auth.drop_person_standing().unwrap();
        let pending = auth.pending_pairings().unwrap();
        assert!(pending.iter().all(|each| each.id != personal_pending.id));
        assert!(pending.iter().any(|each| each.id == ordinary.id));
    }
}
