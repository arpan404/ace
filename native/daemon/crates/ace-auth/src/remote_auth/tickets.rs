// SPDX-License-Identifier: Apache-2.0
//! Tickets on `RemoteAuth` (`remote-auth.ts:176`-`:235`): issuing one for a paired device, the
//! welcome's handover, the direct consume (spend, then check the device) and the NK first
//! message's early consume (check epoch and device, then spend), plus touch and clearing.

use crate::devices::{Device, PairedDevice, SessionActor, hash};
use crate::error::{AuthError, Result};
use crate::remote_auth::{HandedOver, HandedTicket, RemoteAuth, local_only};
use crate::tickets::{IssueError, TicketBinding, TicketPool};

impl RemoteAuth {
    pub fn ticket(&mut self, device: &PairedDevice, epoch: &str) -> Result<HandedTicket> {
        if device.device.scopes.iter().any(|scope| !scope.pairable()) {
            return Err(AuthError::access(403, "Desktop credentials are local only"));
        }
        let ticket = self.runtime.secret();
        let now = self.now();
        let allocation = self
            .tickets
            .issue(
                &hash(&ticket),
                &device.device.id,
                &device.generation,
                now,
                epoch,
            )
            .map_err(|error: IssueError| AuthError::access(429, error.message()))?;
        Ok(HandedTicket {
            ticket,
            expires_at: allocation.expires_at,
        })
    }

    /// The next ticket for a paired device whose socket just opened with one (`remote-auth.ts:197`).
    pub fn hand_over(&mut self, actor: &SessionActor, epoch: &str) -> Option<HandedOver> {
        if !actor.revocable {
            return None;
        }
        let generation = actor.generation.clone()?;
        let device = PairedDevice {
            device: actor.device.clone(),
            generation,
            person: actor.person == Some(true),
        };
        let issued = self.ticket(&device, epoch).ok()?;
        Some(HandedOver {
            ticket: issued.ticket,
            ttl_ms: issued.expires_at - self.now(),
        })
    }

    /// The ticket is consumed first, then its device is checked (`remote-auth.ts:209`).
    pub fn consume(&mut self, ticket: &str) -> Option<PairedDevice> {
        let now = self.now();
        let issued = self.tickets.consume(&hash(ticket), now, None)?;
        let device = self
            .devices
            .current(&issued.device_id, Some(&issued.generation), now)
            .ok()
            .flatten()?;
        if local_only(&device.device) {
            return None;
        }
        self.devices.touch(&device.device.id, now).ok()?;
        Some(device)
    }

    /// A ticket in an NK first message (`remote-auth.ts:224`): the epoch and claimed device are
    /// checked before it is taken, so a message that would be refused spends nothing, and
    /// nothing about the device is recorded until the client's confirmation (`touch`).
    pub fn consume_early(
        &mut self,
        ticket: &str,
        epoch: &str,
        device_id: &str,
    ) -> Option<PairedDevice> {
        let now = self.now();
        let issued =
            self.tickets
                .consume(&hash(ticket), now, Some(TicketBinding { epoch, device_id }))?;
        let device = self
            .devices
            .current(&issued.device_id, Some(&issued.generation), now)
            .ok()
            .flatten()?;
        if local_only(&device.device) {
            return None;
        }
        Some(device)
    }

    /// A paired device whose NK session confirmed was seen now.
    pub fn touch(&mut self, device: &Device) -> Result<()> {
        self.devices.touch(&device.id, self.now())
    }

    /// A paired device's credential was replaced by pairing the same install again.
    pub fn clear_pending(&mut self) -> Result<()> {
        self.codes.clear()?;
        self.tickets = TicketPool::new(self.ticket_limits);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    //! Ported cases live beside the methods they prove; see each file's header for its
    //! TypeScript source.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use crate::devices::{Scope, SessionActor};
    use crate::pairing::PairingTerms;
    use crate::pairing_issue::unique_scopes;
    use crate::remote_auth::RemoteAuth;
    use crate::remote_auth::support::{Home, pair_with};
    use crate::tickets::TicketLimits;

    #[test]
    fn a_ticket_opens_one_nk_session_only_under_its_relay_key_and_for_its_own_device() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        let actor = SessionActor::paired(device.clone());
        let first = auth.hand_over(&actor, "relay-key-a").unwrap().ticket;
        // Refused without being spent: under another key, or claimed by another device.
        assert!(
            auth.consume_early(&first, "relay-key-b", &device.device.id)
                .is_none()
        );
        assert!(
            auth.consume_early(&first, "relay-key-a", "another-device")
                .is_none()
        );
        assert_eq!(
            auth.consume_early(&first, "relay-key-a", &device.device.id)
                .expect("the matching binding")
                .device
                .id,
            device.device.id
        );
        assert!(
            auth.consume_early(&first, "relay-key-a", &device.device.id)
                .is_none()
        );
        // One handed on the direct path is bound to no relay key.
        let direct = auth.hand_over(&actor, "").unwrap().ticket;
        assert!(
            auth.consume_early(&direct, "relay-key-a", &device.device.id)
                .is_none()
        );
    }

    #[test]
    fn revoking_the_device_voids_its_outstanding_tickets_and_a_ticket_lives_sixty_seconds() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        let actor = SessionActor::paired(device.clone());
        let kept = auth.hand_over(&actor, "key").unwrap().ticket;
        let late = auth.hand_over(&actor, "key").unwrap().ticket;
        home.advance(60_001);
        assert!(
            auth.consume_early(&late, "key", &device.device.id)
                .is_none()
        );
        let fresh = auth.hand_over(&actor, "key").unwrap().ticket;
        assert!(auth.revoke(&device.device.id).unwrap());
        assert!(
            auth.consume_early(&fresh, "key", &device.device.id)
                .is_none()
        );
        assert!(
            auth.consume_early(&kept, "key", &device.device.id)
                .is_none()
        );
    }

    #[test]
    fn an_early_ticket_records_nothing_about_the_device_until_it_is_touched() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        let actor = SessionActor::paired(device.clone());
        let seen = |auth: &RemoteAuth| {
            auth.list()
                .unwrap()
                .into_iter()
                .find(|each| each.id == device.device.id)
                .unwrap()
                .last_seen_at
        };
        let before = seen(&auth);
        home.advance(5_000);
        let ticket = auth.hand_over(&actor, "key").unwrap().ticket;
        let consumed = auth
            .consume_early(&ticket, "key", &device.device.id)
            .expect("a valid early ticket");
        assert_eq!(seen(&auth), before);
        auth.touch(&consumed.device).unwrap();
        assert_ne!(seen(&auth), before);
    }

    #[test]
    fn a_handed_ticket_opens_the_next_socket_once_and_a_revocation_voids_it() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(&mut auth, &[Scope::Projects], "Phone", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        let actor = SessionActor::paired(device.clone());
        let first = auth
            .hand_over(&actor, "")
            .expect("a paired device gets one");
        assert!(first.ttl_ms > 0 && first.ttl_ms <= 60_000);
        // The next connect skips the exchange, and hands over another.
        let next = auth
            .consume(&first.ticket)
            .expect("the handed ticket opens the next socket");
        let second = auth
            .hand_over(&SessionActor::paired(next), "")
            .expect("the next connection gets one too");
        assert_ne!(second.ticket, first.ticket);
        assert!(auth.consume(&first.ticket).is_none());
        // Revoking voids the ticket its last welcome handed over.
        auth.revoke(&device.device.id).unwrap();
        assert!(auth.consume(&second.ticket).is_none());
    }

    #[test]
    fn a_client_that_does_not_ask_or_is_not_paired_gets_no_ticket() {
        let home = Home::new();
        let mut auth = home.memory();
        let host = SessionActor::host(crate::devices::Device {
            id: "device".to_owned(),
            name: "Host".to_owned(),
            scopes: vec![Scope::Admin, Scope::Projects, Scope::Accounts],
            created_at: 0,
            last_seen_at: 1_000_000,
            revoked_at: None,
            expires_at: None,
        });
        assert!(auth.hand_over(&host, "").is_none());
    }

    #[test]
    fn a_ticket_route_refusal_names_the_quota_and_a_guest_gets_no_admin() {
        let home = Home::new();
        let mut auth = home.start_with(TicketLimits {
            global: 10_000,
            per_device: 1,
            per_minute: 120,
        });
        let paired = pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        assert!(auth.ticket(&device, "").is_ok());
        let error = auth.ticket(&device, "").unwrap_err();
        assert_eq!(error.status(), 429);
        assert_eq!(error.message(), "Device ticket quota exceeded");
        // `requireAdmin` is the route's and the command lane's check.
        let actor = SessionActor::paired(auth.device_bearer(&paired.token).unwrap());
        assert_eq!(
            auth.require_admin(Some(&actor)).unwrap_err().message(),
            "Admin scope required"
        );
        assert!(
            unique_scopes(&[Scope::Read, Scope::Read, Scope::Operate])
                == vec![Scope::Read, Scope::Operate]
        );
    }

    #[test]
    fn clearing_pending_voids_tickets_and_links_but_not_devices() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        let ticket = auth.ticket(&device, "").unwrap();
        let link = auth
            .pairing(&[Scope::Read], &PairingTerms::default())
            .unwrap();
        auth.clear_pending().unwrap();
        assert!(auth.consume(&ticket.ticket).is_none());
        assert_eq!(
            auth.redeem(&link.code, "Phone", None, None)
                .unwrap_err()
                .message(),
            "Invalid or expired pairing code"
        );
        assert!(auth.device_bearer(&paired.token).is_some());
    }

    #[test]
    fn a_hello_credential_in_a_dedicated_channel_still_needs_the_device_it_names() {
        // The channel is the transport's; what T2 guarantees is that a ticket names its device.
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(&mut auth, &[Scope::Admin], "Viewer", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        let ticket = auth.ticket(&device, "").unwrap().ticket;
        let hello = crate::hello::Hello {
            device_id: "another".to_owned(),
            token: None,
            ticket: Some(ticket),
            grant: None,
            install_id: None,
            channel: Some("devices".to_owned()),
            next_ticket: false,
            machine_code: None,
            link: None,
            media_ticket: None,
            compression: Vec::new(),
            flow_control: Vec::new(),
            trims: Vec::new(),
            framing: Vec::new(),
        };
        assert!(
            crate::hello::hello_actor(&hello, &mut auth, false)
                .unwrap()
                .is_none()
        );
    }
}
