// SPDX-License-Identifier: Apache-2.0
//! Which sessions one event belongs to (`routes.ts:6`-`:31`). A positive answer
//! is cached by session or shell; every hit still asks each candidate whether it
//! is still a match, and a cached list that matches nothing is recomputed over
//! every tenant.
//!
//! Ported from `packages/adapter-opencode/src/routes.ts`. The cache is
//! `translate::cache::RecentMap` (E1); a stale entry is replaced with an empty
//! list, which this module never uses as a filter source, so it behaves exactly
//! as the TypeScript's `delete` followed by a fresh select.

use ace_json::Value;
use indexmap::IndexMap;
use std::sync::Arc;

use crate::translate::boundaries::event_session;
use crate::translate::cache::RecentMap;
use crate::translate::data::{fields, get, s_in};

use super::server::{Tenant, TenantId};

/// The ownership cache bound (`new RecentMap(4096)`).
const OWNERS: usize = 4096;

#[derive(Debug)]
pub struct Routes {
    owners: RecentMap<Vec<TenantId>>,
}

impl Default for Routes {
    fn default() -> Self {
        Self::new()
    }
}

impl Routes {
    pub fn new() -> Self {
        Self {
            owners: RecentMap::new(OWNERS),
        }
    }

    /// `routes.clear()`: a subscribe or unsubscribe invalidates every answer.
    pub fn clear(&mut self) {
        self.owners = RecentMap::new(OWNERS);
    }

    /// The tenants that accept `data` at `watermark`, in tenant order. Caches
    /// the positive answers under the event's session id, and under
    /// `shell:<id>` for the two event types that report a shell.
    pub fn select(
        &mut self,
        data: &Value,
        watermark: u64,
        tenants: &IndexMap<TenantId, Arc<dyn Tenant>>,
    ) -> Vec<Arc<dyn Tenant>> {
        let envelope = fields(data);
        let payload = fields(get(envelope, "data"));
        let session = event_session(data);
        let kind = s_in(envelope, "type");
        let key = if !session.is_empty() {
            session
        } else if kind.starts_with("shell.") {
            format!("shell:{}", s_in(payload, "id"))
        } else {
            String::new()
        };
        // An empty key is never cached: `if (key && accepted.length)`.
        let cached = if key.is_empty() {
            Vec::new()
        } else {
            self.owners.get(&key).cloned().unwrap_or_default()
        };
        // No cached answer selects over every tenant, as `(cached ?? [...consumers])`.
        let mut accepted = if cached.is_empty() {
            self.keep_all(tenants, data, watermark)
        } else {
            self.keep(&cached, tenants, data, watermark)
        };
        if !cached.is_empty() && accepted.is_empty() {
            // The cached owners no longer match: select over every tenant, as
            // the TypeScript's `delete` then recursive call does.
            accepted = self.keep_all(tenants, data, watermark);
        }
        if !key.is_empty() && !accepted.is_empty() {
            self.owners
                .set(key, accepted.iter().map(|(id, _)| *id).collect());
        }
        let shell = if kind == "shell.created" {
            s_in(fields(get(payload, "info")), "id").to_owned()
        } else if kind.starts_with("session.tool.") {
            s_in(fields(get(payload, "metadata")), "shellID").to_owned()
        } else {
            String::new()
        };
        if !shell.is_empty() && !accepted.is_empty() {
            self.owners.set(
                format!("shell:{shell}"),
                accepted.iter().map(|(id, _)| *id).collect(),
            );
        }
        accepted.into_iter().map(|(_, tenant)| tenant).collect()
    }

    /// The cached ids that are still subscribed and still accept the event.
    fn keep(
        &self,
        ids: &[TenantId],
        tenants: &IndexMap<TenantId, Arc<dyn Tenant>>,
        data: &Value,
        watermark: u64,
    ) -> Vec<(TenantId, Arc<dyn Tenant>)> {
        ids.iter()
            .filter_map(|id| tenants.get_key_value(id))
            .filter(|(_, tenant)| tenant.accepts(data, watermark))
            .map(|(id, tenant)| (*id, Arc::clone(tenant)))
            .collect()
    }

    /// Every subscribed tenant that accepts the event, in subscription order.
    fn keep_all(
        &self,
        tenants: &IndexMap<TenantId, Arc<dyn Tenant>>,
        data: &Value,
        watermark: u64,
    ) -> Vec<(TenantId, Arc<dyn Tenant>)> {
        tenants
            .iter()
            .filter(|(_, tenant)| tenant.accepts(data, watermark))
            .map(|(id, tenant)| (*id, Arc::clone(tenant)))
            .collect()
    }
}

#[cfg(test)]
mod tests;
