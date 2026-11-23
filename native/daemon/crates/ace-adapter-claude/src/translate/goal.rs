// SPDX-License-Identifier: Apache-2.0
//! Claude's active goal frame (the port of `goal.ts`).
//! The goal it keeps checking, or none once met or cleared.

use ace_json::{Map, Value};

use super::json::{number, object, str_of};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// The provider goal, explicit null, or undefined when the frame carries
/// nothing ace can show.
pub enum GoalOut {
    Goal(Value),
    Null,
    None,
}

pub fn claude_goal(data: &Value) -> GoalOut {
    let obj = object(data);
    let value = match obj.get("value") {
        Some(Value::Null) => return GoalOut::Null,
        Some(v) if v.is_object() => v,
        _ => return GoalOut::None,
    };
    let vobj = object(value);
    let objective = vobj
        .get("condition")
        .map(|v| str_of(v).trim().to_owned())
        .unwrap_or_default();
    if objective.is_empty() || objective.chars().count() > 4000 {
        return GoalOut::None;
    }
    let checks_f = number(vobj.get("iterations").unwrap_or(&Value::Null));
    let checks_int = checks_f.trunc() as i64;
    if checks_int < 0 || checks_f > MAX_SAFE {
        return GoalOut::None;
    }
    let set_at = number(vobj.get("set_at").unwrap_or(&Value::Null)).trunc() as i64;
    // A non-positive set_at is omitted, like the TypeScript
    // (`...(setAt > 0 ? { setAt } : {})`), rather than failing.
    let reason = vobj
        .get("last_reason")
        .map(|v| str_of(v).trim().to_owned())
        .unwrap_or_default();
    if reason.chars().count() > 4000 {
        return GoalOut::None;
    }
    let mut map = Map::with_capacity(6);
    map.insert("objective".to_owned(), Value::from(objective));
    map.insert("status".to_owned(), Value::from("active".to_owned()));
    map.insert("checks".to_owned(), Value::Number(checks_int.into()));
    if set_at > 0 {
        map.insert("setAt".to_owned(), Value::Number(set_at.into()));
    }
    if !reason.is_empty() {
        map.insert("lastReason".to_owned(), Value::from(reason));
    }
    GoalOut::Goal(Value::Object(map))
}
