// SPDX-License-Identifier: Apache-2.0
//! A test home restarted between daemon starts, shared by `RemoteAuth`'s test modules.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::devices::Devices;
use crate::pairing::{MemoryPairingCodes, SqlitePairingCodes};
use crate::remote_auth::{RedeemedDevice, RemoteAuth};
use crate::tickets::{TicketLimits, default_ticket_limits};
use crate::{CredentialRuntime, Runtime};

/// One daemon home; each `start` is a new daemon process over the same database file.
pub(crate) struct Home {
    _directory: tempfile::TempDir,
    path: PathBuf,
    clock: Arc<Mutex<i64>>,
    secrets: Arc<Mutex<u64>>,
}

impl Home {
    pub(crate) fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        Self {
            _directory: directory,
            path,
            clock: Arc::new(Mutex::new(1_000_000)),
            secrets: Arc::new(Mutex::new(0)),
        }
    }

    pub(crate) fn advance(&self, milliseconds: i64) {
        *self.clock.lock().unwrap() += milliseconds;
    }

    fn runtime(&self) -> Runtime {
        let clock = Arc::clone(&self.clock);
        let secrets = Arc::clone(&self.secrets);
        let ids = Arc::new(Mutex::new(0_u64));
        Runtime::new(
            move || *clock.lock().unwrap(),
            move || {
                let mut secret = secrets.lock().unwrap();
                *secret += 1;
                format!("{secret:064}")
            },
            move || {
                let mut id = ids.lock().unwrap();
                *id += 1;
                format!("pairing-{id}")
            },
        )
    }

    fn devices(&self) -> Devices {
        let counter = Arc::new(Mutex::new(0_u64));
        let entropy = Arc::new(Mutex::new(0_u64));
        let runtime = CredentialRuntime::new(
            move || {
                let mut id = counter.lock().unwrap();
                *id += 1;
                format!("device-{id}")
            },
            move |size| {
                let mut seed = entropy.lock().unwrap();
                *seed += 1;
                let mut bytes = vec![7_u8; size];
                let width = size.min(8);
                bytes[..width].copy_from_slice(&seed.to_be_bytes()[8 - width..]);
                bytes
            },
        );
        Devices::open(self.path.to_str().unwrap(), runtime).unwrap()
    }

    /// A daemon start with the default ticket limits.
    pub(crate) fn start(&self) -> RemoteAuth {
        self.start_with(default_ticket_limits())
    }

    pub(crate) fn start_with(&self, limits: TicketLimits) -> RemoteAuth {
        let devices = self.devices();
        let codes = SqlitePairingCodes::new(devices.connection().clone()).unwrap();
        RemoteAuth::new(
            devices,
            "aa".repeat(32),
            self.runtime(),
            limits,
            Box::new(codes),
        )
    }

    /// A daemon with in-memory pairing codes.
    pub(crate) fn memory(&self) -> RemoteAuth {
        RemoteAuth::new(
            self.devices(),
            "aa".repeat(32),
            self.runtime(),
            default_ticket_limits(),
            Box::new(MemoryPairingCodes::new()),
        )
    }
}

/// Issue a link and redeem it, as a client pairing does.
pub(super) fn pair_with(
    auth: &mut RemoteAuth,
    scopes: &[crate::devices::Scope],
    name: &str,
    install: Option<&str>,
    standing: Option<&str>,
) -> RedeemedDevice {
    let code = auth
        .pairing(scopes, &crate::pairing::PairingTerms::default())
        .unwrap()
        .code;
    auth.redeem(&code, name, install, standing).unwrap()
}
