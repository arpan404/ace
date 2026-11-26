// SPDX-License-Identifier: Apache-2.0
//! The notes the server core publishes itself, on each tenant's ordered queue:
//! the activity note (`server.ts:399`-`:403`) and the two recovery notes
//! (`:447`, `:451`). A note's text is `JSON.stringify`d with `ace_json`, so a
//! string field escapes exactly as the TypeScript's does.

use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::SessionEvent;
use ace_json::{Map, Value};

use super::server::Tenant;

/// The activity note's channel (`server.ts:402`).
pub const ACTIVITY: &str = "transport.activity";
/// Buffered events were dropped and the pass must restart (`server.ts:447`).
pub const RESTARTED: &str = "recovery.restarted";
/// One event was buffered for the replay (`server.ts:451`).
pub const BUFFERED: &str = "recovery.buffered";

/// A note's text, with the fields in the order given.
pub fn text(fields: &[(&str, Value)]) -> String {
    let mut map = Map::new();
    for (key, value) in fields {
        map.insert((*key).to_owned(), value.clone());
    }
    ace_json::to_string(&Value::Object(map))
}

/// One note on a tenant's queue; the queue assigns its seq.
pub fn publish(tenant: &dyn Tenant, channel: &'static str, text: String) {
    tenant.queue().publish(vec![SessionEvent::Frame {
        seq: 0,
        dir: FrameDirection::Note,
        channel: channel.to_owned(),
        text,
    }]);
}
