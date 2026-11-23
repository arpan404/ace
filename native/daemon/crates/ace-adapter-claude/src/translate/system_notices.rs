// SPDX-License-Identifier: Apache-2.0
//! Human-readable system notices (the port of `system-notices.ts`).
//! Only documented system messages enter the transcript.

use ace_json::Value;

use super::json::object;

pub struct SystemNotice {
    pub text: String,
    pub level: String,
}

pub fn system_notice(value: &Value) -> Option<SystemNotice> {
    let obj = object(value);
    let subtype = obj.get("subtype").and_then(|v| v.as_str())?;
    match subtype {
        "informational" => {
            let content = obj.get("content").and_then(|v| v.as_str())?;
            if content.is_empty() {
                return None;
            }
            let level = obj.get("level").and_then(|v| v.as_str())?;
            let prevent = obj.get("prevent_continuation") == Some(&Value::Bool(true));
            let mapped = match level {
                "info" | "notice" | "suggestion" | "warning" => level,
                _ => return None,
            };
            let out = if prevent || mapped == "warning" {
                "warning"
            } else {
                "info"
            };
            Some(SystemNotice {
                text: content.to_owned(),
                level: out.to_owned(),
            })
        }
        "local_command_output" => {
            let content = obj.get("content").and_then(|v| v.as_str())?;
            if content.is_empty() {
                return None;
            }
            Some(SystemNotice {
                text: content.to_owned(),
                level: "info".to_owned(),
            })
        }
        "mirror_error" => {
            let error = obj.get("error").and_then(|v| v.as_str())?;
            if error.is_empty() {
                return None;
            }
            Some(SystemNotice {
                text: error.to_owned(),
                level: "error".to_owned(),
            })
        }
        _ => None,
    }
}
