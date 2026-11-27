// SPDX-License-Identifier: Apache-2.0
//! Steer continuation (the port of `steer-continuation.ts`).
//! Claude takes a steer into a running turn by aborting the in-flight
//! request and running the steer straight after, as a fresh native turn.

use ace_json::Value;

use super::json::object;

pub struct SteerContinuation {
    steered: bool,
    stopped: bool,
}

impl SteerContinuation {
    pub fn new() -> Self {
        SteerContinuation {
            steered: false,
            stopped: false,
        }
    }

    pub fn observe(&mut self, dir: &str, channel: &str, active_root: bool, data: &Value) {
        if dir != "send" {
            return;
        }
        let obj = object(data);
        let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "user"
            && channel == "sdk"
            && obj.get("priority").and_then(|v| v.as_str()) == Some("now")
            && active_root
        {
            self.steered = true;
        }
        if kind == "control_request"
            && object(obj.get("request").unwrap_or(&Value::Null))
                .get("subtype")
                .and_then(|v| v.as_str())
                == Some("interrupt")
        {
            self.stopped = true;
        }
        if kind == "control_response" {
            let response = object(obj.get("response").unwrap_or(&Value::Null));
            let inner = object(response.get("response").unwrap_or(&Value::Null));
            if inner.get("interrupt") == Some(&Value::Bool(true)) {
                self.stopped = true;
            }
        }
    }

    /// Whether the root's aborted result only made way for a steer.
    /// Each result settles both flags.
    pub fn carries_on(&mut self, aborted: bool) -> bool {
        let carries = aborted && self.steered && !self.stopped;
        self.steered = false;
        self.stopped = false;
        carries
    }
}

impl Default for SteerContinuation {
    fn default() -> Self {
        Self::new()
    }
}
