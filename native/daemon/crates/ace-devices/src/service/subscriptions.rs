// SPDX-License-Identifier: Apache-2.0
//! One subscription per device (streams, logs) on a connection, at most four
//! (`packages/devices/src/subscriptions.ts`).
//!
//! A new subscription is staged: the device's current one keeps going until the
//! new one attaches (then it is released), so a resubscribe that fails leaves it
//! as it was. A later stage of the same device supersedes an earlier one still
//! being set up.
//!
//! Sans-IO: the shell supplies each subscription's release as an opaque id, and
//! these calls hand back the ids to call.

use indexmap::IndexMap;

use crate::error::DeviceErrorCode;

/// At most this many devices hold a subscription on one connection.
pub const MAX_SUBSCRIPTIONS: usize = 4;
/// The refusal past [`MAX_SUBSCRIPTIONS`] (`subscriptions.ts:14`).
pub const SUBSCRIPTION_LIMIT: &str = "Device subscription limit";

/// One device's subscription slot.
#[derive(Debug)]
struct Slot {
    /// Identifies the stage: two reserves of one device are different slots.
    id: u64,
    active: bool,
    release: Option<u64>,
}

/// One staged subscription, until it attaches or is cancelled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reservation {
    device: String,
    slot: u64,
}

impl Reservation {
    pub fn device(&self) -> &str {
        &self.device
    }
}

/// One connection's stream and log subscriptions.
#[derive(Debug, Default)]
pub struct DeviceSubscriptions {
    /// The subscriptions in force, by device.
    slots: IndexMap<String, Slot>,
    /// The ones being set up, by device.
    staged: IndexMap<String, Slot>,
    next_slot: u64,
}

impl DeviceSubscriptions {
    pub fn new() -> Self {
        Self::default()
    }

    /// `reserve`: stage a subscription for this device, superseding an earlier
    /// stage of it, and refusing a fifth device.
    pub fn reserve(&mut self, device: &str) -> Result<Reservation, String> {
        let mut held = self.slots.len();
        for id in self.staged.keys() {
            if !self.slots.contains_key(id) {
                held += 1;
            }
        }
        if !self.slots.contains_key(device)
            && !self.staged.contains_key(device)
            && held >= MAX_SUBSCRIPTIONS
        {
            return Err(String::from(SUBSCRIPTION_LIMIT));
        }
        if let Some(earlier) = self.staged.get_mut(device) {
            earlier.active = false;
        }
        self.next_slot = self.next_slot.saturating_add(1);
        let slot = self.next_slot;
        self.staged.insert(
            device.to_owned(),
            Slot {
                id: slot,
                active: true,
                release: None,
            },
        );
        Ok(Reservation {
            device: device.to_owned(),
            slot,
        })
    }

    /// Whether the reservation's subscription may still take the device: a later
    /// stage of it, or a removal, says no.
    pub fn active(&self, reservation: &Reservation) -> bool {
        self.find(reservation).is_some_and(|slot| slot.active)
    }

    /// `attach`: set up, so this subscription replaces the device's current one.
    /// Returns the releases to call: the superseded one, or this one when a later
    /// stage passed it before it attached.
    pub fn attach(&mut self, reservation: &Reservation, release: u64) -> Vec<u64> {
        // A later stage of the device replaced this one: it never takes over, and
        // its own subscription is released at once (`subscriptions.ts:26`).
        let current = self
            .staged
            .get(&reservation.device)
            .is_some_and(|slot| slot.id == reservation.slot)
            || self
                .slots
                .get(&reservation.device)
                .is_some_and(|slot| slot.id == reservation.slot);
        if !current {
            return vec![release];
        }
        let Some(mut slot) = self.take(reservation) else {
            return Vec::new();
        };
        if !slot.active {
            return vec![release];
        }
        let mut released = Vec::new();
        // A second attach of the same reservation releases what it attached before.
        if let Some(previous) = slot.release.take() {
            released.push(previous);
        }
        if let Some(old) = self.slots.get_mut(&reservation.device) {
            old.active = false;
            if let Some(previous) = old.release.take() {
                released.push(previous);
            }
        }
        slot.release = Some(release);
        self.slots.insert(reservation.device.clone(), slot);
        released
    }

    /// `cancel`: setup failed, so the device's current subscription stays.
    pub fn cancel(&mut self, reservation: &Reservation) {
        if self
            .staged
            .get(&reservation.device)
            .is_some_and(|slot| slot.id == reservation.slot)
        {
            self.staged.shift_remove(&reservation.device);
        }
        if let Some(slot) = self.find_mut(reservation) {
            slot.active = false;
        }
    }

    /// `remove`: release this device's subscription and any stage of it.
    pub fn remove(&mut self, device: &str) -> Vec<u64> {
        // The staged slot is dropped: nothing holds it any more, so its `active`
        // flag has no reader (the TypeScript sets it, then deletes it).
        let _ = self.staged.shift_remove(device);
        let Some(mut slot) = self.slots.shift_remove(device) else {
            return Vec::new();
        };
        slot.active = false;
        slot.release.into_iter().collect()
    }

    /// `close`: release every device once, committed ones first.
    pub fn close(&mut self) -> Vec<u64> {
        let devices: Vec<String> = self
            .slots
            .keys()
            .chain(self.staged.keys())
            .cloned()
            .collect();
        let mut released = Vec::new();
        for device in devices {
            released.extend(self.remove(&device));
        }
        released
    }

    /// How many devices hold a subscription, for tests and diagnostics.
    pub fn len(&self) -> usize {
        let mut held = self.slots.len();
        for id in self.staged.keys() {
            if !self.slots.contains_key(id) {
                held += 1;
            }
        }
        held
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn find(&self, reservation: &Reservation) -> Option<&Slot> {
        if let Some(slot) = self
            .staged
            .get(&reservation.device)
            .filter(|slot| slot.id == reservation.slot)
        {
            return Some(slot);
        }
        self.slots
            .get(&reservation.device)
            .filter(|slot| slot.id == reservation.slot)
    }

    fn find_mut(&mut self, reservation: &Reservation) -> Option<&mut Slot> {
        if self
            .staged
            .get(&reservation.device)
            .is_some_and(|slot| slot.id == reservation.slot)
        {
            return self.staged.get_mut(&reservation.device);
        }
        if self
            .slots
            .get(&reservation.device)
            .is_some_and(|slot| slot.id == reservation.slot)
        {
            return self.slots.get_mut(&reservation.device);
        }
        None
    }

    /// Take the reservation's slot out of whichever map holds it, as the
    /// TypeScript's `unstage` plus the `slots.get` that follows it do.
    fn take(&mut self, reservation: &Reservation) -> Option<Slot> {
        if self
            .staged
            .get(&reservation.device)
            .is_some_and(|slot| slot.id == reservation.slot)
        {
            return self.staged.shift_remove(&reservation.device);
        }
        if self
            .slots
            .get(&reservation.device)
            .is_some_and(|slot| slot.id == reservation.slot)
        {
            return self.slots.shift_remove(&reservation.device);
        }
        None
    }
}

/// The typed refusal a shell raises for [`SUBSCRIPTION_LIMIT`].
pub fn subscription_limit() -> crate::error::DeviceError {
    crate::error::DeviceError::coded(
        DeviceErrorCode::CommandFailed,
        SUBSCRIPTION_LIMIT,
        crate::error::GENERIC_HINT,
    )
}

#[cfg(test)]
mod tests;
