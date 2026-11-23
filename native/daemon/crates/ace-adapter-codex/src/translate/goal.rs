// SPDX-License-Identifier: Apache-2.0
//! Codex thread goals in ace's shape.

use serde_json::{Map, Value};

use super::helpers::{obj_map, str_empty};

fn count_value(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(n)) => {
            let v = n.as_i64()?;
            if v >= 0 && v as f64 <= 9_007_199_254_740_991.0 {
                Some(v)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn valid_status(status: &str) -> Option<&'static str> {
    match status {
        "active" => Some("active"),
        "paused" => Some("paused"),
        "blocked" => Some("blocked"),
        "usageLimited" => Some("usage_limited"),
        "budgetLimited" => Some("budget_limited"),
        "complete" => Some("complete"),
        _ => None,
    }
}

/// `codexGoal`: undefined when it has no objective or an unknown status.
pub fn codex_goal(value: &Value) -> Option<Value> {
    let goal = obj_map(value);
    let status = valid_status(str_empty(goal.get("status")))?;
    let objective = str_empty(goal.get("objective")).trim().to_owned();
    let objective_units = objective.encode_utf16().count();
    if !(1..=4000).contains(&objective_units) {
        return None;
    }
    let tokens_used = count_value(goal.get("tokensUsed"));
    let token_budget = count_value(goal.get("tokenBudget"));
    let time_used = count_value(goal.get("timeUsedSeconds"));
    let created_at = count_value(goal.get("createdAt"));
    let mut map = Map::with_capacity(6);
    map.insert("objective".to_owned(), Value::String(objective));
    map.insert("status".to_owned(), Value::String(status.to_owned()));
    if let Some(v) = tokens_used {
        map.insert("tokensUsed".to_owned(), Value::Number(v.into()));
    }
    if let Some(v) = token_budget {
        map.insert("tokenBudget".to_owned(), Value::Number(v.into()));
    }
    if let Some(v) = time_used {
        map.insert("timeUsedSeconds".to_owned(), Value::Number(v.into()));
    }
    if let Some(v) = created_at {
        map.insert("setAt".to_owned(), Value::Number((v * 1000).into()));
    }
    Some(Value::Object(map))
}
