// SPDX-License-Identifier: Apache-2.0
//! Connection lifetimes for stream owners (`packages/devices/src/stream-owners.ts`):
//! they survive asynchronous lookups without retaining a disconnected owner.
//!
//! One owner's views of a device overlap while a resubscribe is set up beside the
//! view it replaces, so the owner's stream request goes only when the last of them
//! ends, and a resubscribe that fails never takes it from the view still running.
//!
//! Sans-IO: the shell supplies each view's release as an opaque id, and `release`
//! hands back the id to call when the last view ends.

use indexmap::IndexMap;

/// A subscription asked for by an owner that already disconnected.
pub const DISCONNECTED: &str = "Device viewer disconnected";

/// One owner's scope: whether its connection lives, and its views by device.
#[derive(Debug, Default)]
struct Scope {
    active: bool,
    /// device → the live view tokens, oldest first.
    subscriptions: IndexMap<String, Vec<u64>>,
}

/// One owner's scope, as `scope(owner)` returned it. Its guard is what an
/// asynchronous lookup re-checks: after the owner disconnected, it fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopeHandle {
    id: u64,
}

/// One view of a device, until it ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    scope: u64,
    device: String,
    token: u64,
    release: u64,
}

/// Every owner's views.
#[derive(Debug, Default)]
pub struct StreamOwners {
    /// Kept until the last view ends, so a release after a disconnect still counts.
    scopes: IndexMap<u64, Scope>,
    by_owner: IndexMap<String, u64>,
    next_scope: u64,
    next_token: u64,
}

impl StreamOwners {
    pub fn new() -> Self {
        Self::default()
    }

    /// `scope(owner)`: the owner's scope, created the first time it is asked for.
    pub fn scope(&mut self, owner: &str) -> ScopeHandle {
        if let Some(id) = self.by_owner.get(owner).copied() {
            return ScopeHandle { id };
        }
        self.next_scope = self.next_scope.saturating_add(1);
        let id = self.next_scope;
        self.scopes.insert(
            id,
            Scope {
                active: true,
                subscriptions: IndexMap::new(),
            },
        );
        self.by_owner.insert(owner.to_owned(), id);
        ScopeHandle { id }
    }

    /// `guard`: the scope's connection still lives.
    pub fn guard(&self, scope: &ScopeHandle) -> Result<(), String> {
        match self.scopes.get(&scope.id) {
            Some(scope) if scope.active => Ok(()),
            _ => Err(String::from(DISCONNECTED)),
        }
    }

    /// `scope(owner).subscribe(device, release)`: one more view of the device.
    pub fn subscribe(
        &mut self,
        scope: &ScopeHandle,
        device: &str,
        release: u64,
    ) -> Result<Subscription, String> {
        self.guard(scope)?;
        let scope_id = scope.id;
        let Some(scope) = self.scopes.get_mut(&scope_id) else {
            return Err(String::from(DISCONNECTED));
        };
        self.next_token = self.next_token.saturating_add(1);
        let token = self.next_token;
        scope
            .subscriptions
            .entry(device.to_owned())
            .or_default()
            .push(token);
        Ok(Subscription {
            scope: scope_id,
            device: device.to_owned(),
            token,
            release,
        })
    }

    /// The view ended: the last one of its device hands back the release to call.
    pub fn release(&mut self, subscription: Subscription) -> Option<u64> {
        let scope = self.scopes.get_mut(&subscription.scope)?;
        let views = scope.subscriptions.get_mut(&subscription.device)?;
        let index = views
            .iter()
            .position(|token| *token == subscription.token)?;
        views.remove(index);
        let empty = views.is_empty();
        if empty {
            scope.subscriptions.shift_remove(&subscription.device);
        }
        let inactive_and_idle = !scope.active && scope.subscriptions.is_empty();
        if inactive_and_idle {
            self.scopes.shift_remove(&subscription.scope);
        }
        empty.then_some(subscription.release)
    }

    /// `disconnect`: the owner's connection went, so it holds nothing new.
    pub fn disconnect(&mut self, owner: &str) {
        let Some(scope_id) = self.by_owner.shift_remove(owner) else {
            return;
        };
        if let Some(scope) = self.scopes.get_mut(&scope_id) {
            scope.active = false;
            if scope.subscriptions.is_empty() {
                self.scopes.shift_remove(&scope_id);
            }
        }
    }

    /// `close`: every owner disconnects.
    pub fn close(&mut self) {
        let owners: Vec<String> = self.by_owner.keys().cloned().collect();
        for owner in owners {
            self.disconnect(&owner);
        }
    }

    /// Whether anything is left, for tests and diagnostics.
    pub fn is_empty(&self) -> bool {
        self.by_owner.is_empty() && self.scopes.is_empty()
    }
}

#[cfg(test)]
mod tests;
