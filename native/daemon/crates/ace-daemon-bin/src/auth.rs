// SPDX-License-Identifier: Apache-2.0
//! The daemon's hello and authentication, wired from T2's `ace-auth` crate: the
//! host token on loopback, tickets and paired devices, pairing links in the
//! store, and the welcome a client reads.
//!
//! This module translates; the decisions are `ace-auth`'s (`hello_actor`,
//! `RemoteAuth`, `Devices`). A welcome carries the fields slice 1 can answer:
//! `hostId`, `protocolVersion`, `headSeq` and `databaseId`, plus a handed-over
//! ticket when the hello asked. The service registry, grants and relay
//! handshakes arrive with the slices that own them.
//!
//! TypeScript cases ported: `apps/daemon/src/auth.server.process.test.ts` and
//! `apps/daemon/src/handed-ticket.server.process.test.ts` drive the same
//! `hello_actor`, and this crate's program test drives the frames.

use std::path::Path;
use std::sync::Mutex;

use ace_auth::devices::Devices;
use ace_auth::hello::{FirstFrame, HelloGate};
use ace_auth::pairing::SqlitePairingCodes;
use ace_auth::{CredentialRuntime, RemoteAuth, Runtime, default_ticket_limits, hello_actor};
use serde_json::Value;

use crate::session::{Answer, Welcome};

/// The daemon's authentication state, one lock around T2's `RemoteAuth`.
pub struct DaemonAuth {
    auth: Mutex<RemoteAuth>,
    host_id: String,
    /// A stable id for the store's sidebar reads; the host id until slice 2 owns
    /// the real sidebar token.
    database_id: String,
}

impl DaemonAuth {
    /// Open the devices and pairing tables in the same database the event store
    /// uses, and the host token this daemon answered with.
    pub fn open(home: &Path, token: &str, host_id: &str) -> Result<Self, ace_auth::AuthError> {
        let database = home.join("events.sqlite");
        let credentials = CredentialRuntime::new(
            || {
                crate::ids::uuid_v4()
                    .unwrap_or_else(|_| "00000000-0000-4000-8000-000000000000".to_owned())
            },
            |size| crate::ids::bytes(size).unwrap_or_else(|_| vec![0_u8; size]),
        );
        let devices = Devices::open(&database.to_string_lossy(), credentials)?;
        let codes = SqlitePairingCodes::new(devices.connection().clone())?;
        let runtime = Runtime::new(
            || crate::home::now_ms() as i64,
            || crate::ids::random_hex_32().unwrap_or_else(|_| "0".repeat(64)),
            || crate::ids::uuid_v4().unwrap_or_else(|_| "pairing".to_owned()),
        );
        let auth = RemoteAuth::new(
            devices,
            token,
            runtime,
            default_ticket_limits(),
            Box::new(codes),
        );
        Ok(Self {
            auth: Mutex::new(auth),
            host_id: host_id.to_owned(),
            database_id: host_id.to_owned(),
        })
    }

    /// The welcome frame, in the schema's field order.
    fn welcome(&self, ticket: Option<(String, i64)>) -> Vec<u8> {
        let mut frame = format!(
            "{{\"type\":\"welcome\",\"hostId\":{},\"protocolVersion\":1,\"headSeq\":0,\"databaseId\":{}",
            Value::String(self.host_id.clone()),
            Value::String(self.database_id.clone())
        );
        if let Some((ticket, ttl_ms)) = ticket {
            frame.push_str(&format!(
                ",\"ticket\":{{\"ticket\":{},\"ttlMs\":{ttl_ms}}}",
                Value::String(ticket)
            ));
        }
        frame.push('}');
        frame.into_bytes()
    }
}

impl crate::session::Authenticator for DaemonAuth {
    fn hello(&self, text: &str, local: bool) -> Answer {
        let mut gate = HelloGate::new();
        let hello = match gate.first(FirstFrame::Text(text)) {
            Ok(hello) => hello,
            Err(refusal) => {
                return Answer::Refused {
                    message: refusal.message(),
                };
            }
        };
        let mut auth = self
            .auth
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let actor = match hello_actor(&hello, &mut auth, local) {
            Ok(Some(actor)) => actor,
            Ok(None) => {
                return Answer::Refused {
                    message: "Valid hello required",
                };
            }
            // A store failure ends this socket, never the daemon (`1011`).
            Err(_) => return Answer::Unavailable,
        };
        // A hello that opened with a ticket and asked for the next gets it in the
        // welcome, so its next connection skips the exchange (ADR 0150).
        let next = if hello.next_ticket && hello.ticket.is_some() {
            auth.hand_over(&actor, "")
                .map(|handed| (handed.ticket, handed.ttl_ms))
        } else {
            None
        };
        Answer::Authenticated(Welcome::Frame(self.welcome(next)))
    }
}
