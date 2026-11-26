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

use crate::translate::boundaries::{NativeEvent, event_session};
use crate::translate::cache::RecentMap;
use crate::translate::data::{fields, get, s_in};

use super::server::{Tenant, TenantError, TenantId};

/// The ownership cache bound (`new RecentMap(4096)`).
const OWNERS: usize = 4096;

/// One accepted tenant, with the id its queue was subscribed under.
type Accepted = (TenantId, Arc<dyn Tenant>);

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
    /// `shell:<id>` for the two event types that report a shell. A tenant's
    /// refusal (a shell past its bound) fails the selection, as the TypeScript's
    /// throw inside `filter` fails the stream.
    pub fn select(
        &mut self,
        event: &NativeEvent<'_>,
        data: &Value,
        watermark: u64,
        tenants: &IndexMap<TenantId, Arc<dyn Tenant>>,
    ) -> Result<Vec<Arc<dyn Tenant>>, TenantError> {
        let payload = event.data;
        let session = event_session(data);
        let kind = event.typ;
        let key = if !session.is_empty() {
            session.to_owned()
        } else if kind.starts_with("shell.") {
            format!("shell:{}", s_in(payload, "id"))
        } else {
            String::new()
        };
        // An empty key is never cached: `if (key && accepted.length)`.
        let cached = if key.is_empty() {
            None
        } else {
            self.owners.get(&key).cloned()
        };
        let accepted = match &cached {
            Some(ids) => self.keep(ids, tenants, event, data, watermark)?,
            None => self.keep_all(tenants, event, data, watermark)?,
        };
        if cached.is_some() && accepted.is_empty() {
            // The cached owners no longer match. Delete the entry and select
            // again, as `routes.ts:19` does, so the next event asks every
            // tenant exactly as a cache miss would.
            self.owners.delete(&key);
            return self.select(event, data, watermark, tenants);
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
        Ok(accepted.into_iter().map(|(_, tenant)| tenant).collect())
    }

    /// The cached ids that are still subscribed and still accept the event.
    fn keep(
        &self,
        ids: &[TenantId],
        tenants: &IndexMap<TenantId, Arc<dyn Tenant>>,
        event: &NativeEvent<'_>,
        data: &Value,
        watermark: u64,
    ) -> Result<Vec<Accepted>, TenantError> {
        let mut accepted = Vec::new();
        for id in ids {
            let Some((id, tenant)) = tenants.get_key_value(id) else {
                continue;
            };
            if tenant.accepts(event, data, watermark)? {
                accepted.push((*id, Arc::clone(tenant)));
            }
        }
        Ok(accepted)
    }

    /// Every subscribed tenant that accepts the event, in subscription order.
    fn keep_all(
        &self,
        tenants: &IndexMap<TenantId, Arc<dyn Tenant>>,
        event: &NativeEvent<'_>,
        data: &Value,
        watermark: u64,
    ) -> Result<Vec<Accepted>, TenantError> {
        let mut accepted = Vec::new();
        for (id, tenant) in tenants {
            if tenant.accepts(event, data, watermark)? {
                accepted.push((*id, Arc::clone(tenant)));
            }
        }
        Ok(accepted)
    }
}

#[cfg(test)]
mod tests;
