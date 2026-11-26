// SPDX-License-Identifier: Apache-2.0
//! What the daemon knows of a command a client still waits on. Ports
//! `apps/daemon/src/command-status.ts`: work queued or executing is running; a stored receipt is
//! settled and its result is sent again; a reservation that no longer has work behind it settles
//! as an uncertain outcome; with neither, the daemon has no record and the client may stop
//! waiting.

use ace_json::{JsString, Map, Value};

use crate::js::field_text;

/// `CommandStatusState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandStatusState {
    Running,
    Settled,
    Unknown,
}

impl CommandStatusState {
    pub fn as_str(self) -> &'static str {
        match self {
            CommandStatusState::Running => "running",
            CommandStatusState::Settled => "settled",
            CommandStatusState::Unknown => "unknown",
        }
    }
}

/// One command's state, and the result to send again when it is settled.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandState {
    pub state: CommandStatusState,
    pub result: Option<Value>,
}

/// `commandState(commandId, receipt, inFlight)`.
pub fn command_state(
    command_id: &JsString,
    receipt: Option<&Value>,
    in_flight: bool,
) -> CommandState {
    if in_flight {
        return CommandState {
            state: CommandStatusState::Running,
            result: None,
        };
    }
    if receipt.is_some_and(|receipt| {
        field_text(receipt, "error").is_some_and(|error| error == "client_action_pending")
    }) {
        let mut result = Map::with_capacity(3);
        result.insert("commandId", Value::String(command_id.clone()));
        result.insert("ok", Value::Bool(false));
        result.insert(
            "error",
            Value::String(JsString::from("action_outcome_uncertain")),
        );
        return CommandState {
            state: CommandStatusState::Settled,
            result: Some(Value::Object(result)),
        };
    }
    if let Some(receipt) = receipt {
        return CommandState {
            state: CommandStatusState::Settled,
            result: Some(receipt.clone()),
        };
    }
    CommandState {
        state: CommandStatusState::Unknown,
        result: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        ace_json::parse(text).expect("parse")
    }

    #[test]
    fn work_in_flight_is_running() {
        let state = command_state(&JsString::from("c1"), None, true);
        assert_eq!(state.state, CommandStatusState::Running);
        assert!(state.result.is_none());
    }

    #[test]
    fn a_pending_reservation_settles_as_uncertain() {
        let receipt = parse(r#"{"commandId":"c1","ok":false,"error":"client_action_pending"}"#);
        let state = command_state(&JsString::from("c1"), Some(&receipt), false);
        assert_eq!(state.state, CommandStatusState::Settled);
        assert_eq!(
            state.result.map(|result| ace_json::to_string(&result)),
            Some(r#"{"commandId":"c1","ok":false,"error":"action_outcome_uncertain"}"#.to_owned())
        );
    }
}
