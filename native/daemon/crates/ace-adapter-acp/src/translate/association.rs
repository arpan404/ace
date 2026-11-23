// SPDX-License-Identifier: Apache-2.0
//! Child associations (`association.ts`).

use crate::translate::data::{object, string};
use serde_json::Value;

pub struct ChildAssociation {
    pub id: String,
    pub update_type: String,
    pub status: String,
    pub terminal: bool,
}

/// A subagent association an update names, or None.
pub fn child_association(update: &Value) -> Option<ChildAssociation> {
    let update_map = object(update);
    let kind = string(update_map.get("sessionUpdate").unwrap_or(&Value::Null));
    if ![
        "subagent_spawned",
        "subagent_state_update",
        "subagent_update",
    ]
    .contains(&kind)
    {
        return None;
    }
    // TypeScript reads `update["subagentSessionId"] ?? update["sessionId"]`,
    // so the subagent id wins when both are present.
    let id = {
        let sub = string(update_map.get("subagentSessionId").unwrap_or(&Value::Null));
        if !sub.is_empty() {
            sub.to_owned()
        } else {
            string(update_map.get("sessionId").unwrap_or(&Value::Null)).to_owned()
        }
    };
    if id.is_empty() {
        return None;
    }
    let status = {
        let state_value = update_map.get("state").unwrap_or(&Value::Null);
        if let Some(text) = state_value.as_str() {
            text.to_owned()
        } else {
            string(object(state_value).get("state").unwrap_or(&Value::Null)).to_owned()
        }
    };
    Some(ChildAssociation {
        id,
        update_type: kind.to_owned(),
        terminal: ["completed", "failed", "cancelled", "idle"].contains(&status.as_str()),
        status,
    })
}
