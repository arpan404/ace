// SPDX-License-Identifier: Apache-2.0
//! The socket's hello exchange: one hello per socket, and the frame-level refusals `server.ts`
//! gives a first frame that isn't one (`server.ts:836`–`:866`, `:1018`).

use super::{Hello, HelloRefusal};

/// A first frame, as the transport saw it.
#[derive(Debug, Clone, Copy)]
pub enum FirstFrame<'a> {
    Text(&'a str),
    Binary,
}

/// The hello exchange's own state: one hello per socket.
#[derive(Debug, Clone, Copy, Default)]
pub struct HelloGate {
    authenticated: bool,
}

impl HelloGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn authenticated(&self) -> bool {
        self.authenticated
    }

    /// Parse the first frame. The actor's resolution is separate, so a caller can run the hello
    /// against a live [`RemoteAuth`] and answer with its refusal.
    pub fn first(&mut self, frame: FirstFrame<'_>) -> Result<Hello, HelloRefusal> {
        let text = match frame {
            FirstFrame::Text(text) => text,
            FirstFrame::Binary => return Err(HelloRefusal::Binary),
        };
        let value = ace_json::parse(text).map_err(|_| HelloRefusal::Malformed)?;
        Hello::parse(&value)
    }

    /// A hello after the welcome is refused, without another welcome or heartbeat.
    pub fn later(&mut self) -> HelloRefusal {
        HelloRefusal::Later
    }

    /// The welcome is on the wire: the socket is no longer pre-authentication.
    pub fn welcomed(&mut self) {
        self.authenticated = true;
    }
}

#[cfg(test)]
mod tests {
    //! Ports `apps/daemon/src/auth.server.process.test.ts`'s first-frame refusals and its second
    //! hello case.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{FirstFrame, HelloGate};
    use crate::hello::HelloRefusal;

    #[test]
    fn a_non_hello_first_frame_is_refused_without_data() {
        let mut gate = HelloGate::new();
        assert_eq!(
            gate.first(FirstFrame::Text("{\"type\":\"ping\"}")),
            Err(HelloRefusal::NotHello)
        );
        assert_eq!(HelloRefusal::NotHello.code(), "unauthorized");
        assert_eq!(HelloRefusal::NotHello.message(), "Valid hello required");
        assert_eq!(HelloRefusal::NotHello.close_code(), 4001);
    }

    #[test]
    fn json_that_is_not_an_object_fails_the_schema_rather_than_reading_as_another_type() {
        for frame in ["null", "[1]", "\"hi\"", "3"] {
            let mut gate = HelloGate::new();
            assert_eq!(
                gate.first(FirstFrame::Text(frame)),
                Err(HelloRefusal::Malformed),
                "{frame}"
            );
            assert_eq!(
                HelloRefusal::Malformed.message(),
                "Message does not match the protocol"
            );
        }
        // A socket message of another type is the "Valid hello required" case.
        let mut gate = HelloGate::new();
        assert_eq!(
            gate.first(FirstFrame::Text("{\"type\":\"ping\"}")),
            Err(HelloRefusal::NotHello)
        );
    }

    #[test]
    fn a_binary_first_frame_is_refused_even_when_it_contains_a_valid_hello() {
        let mut gate = HelloGate::new();
        assert_eq!(gate.first(FirstFrame::Binary), Err(HelloRefusal::Binary));
        assert_eq!(HelloRefusal::Binary.code(), "unauthorized");
    }

    #[test]
    fn an_unsupported_protocol_version_a_missing_or_a_doubled_credential_is_malformed() {
        let mut gate = HelloGate::new();
        let two =
            "{\"type\":\"hello\",\"protocolVersion\":2,\"deviceId\":\"device\",\"token\":\"x\"}";
        assert_eq!(
            gate.first(FirstFrame::Text(two)),
            Err(HelloRefusal::Malformed)
        );
        let none = "{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"device\"}";
        assert_eq!(
            gate.first(FirstFrame::Text(none)),
            Err(HelloRefusal::Malformed)
        );
        let both = "{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"device\",\"token\":\"x\",\"ticket\":\"y\"}";
        assert_eq!(
            gate.first(FirstFrame::Text(both)),
            Err(HelloRefusal::Malformed)
        );
        // A malformed frame answers the schema's message, as `server.ts` does.
        assert_eq!(
            HelloRefusal::Malformed.message(),
            "Message does not match the protocol"
        );
    }

    #[test]
    fn a_second_hello_is_refused_without_another_welcome() {
        let mut gate = HelloGate::new();
        gate.welcomed();
        assert!(gate.authenticated());
        assert_eq!(gate.later(), HelloRefusal::Later);
        assert_eq!(HelloRefusal::Later.message(), "Hello is only valid once");
    }
}
