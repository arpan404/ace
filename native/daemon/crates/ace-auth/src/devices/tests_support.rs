// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::unwrap_used, clippy::expect_used)]

//! The devices tests' one home: a fresh home with a database, and the link proof a test needs.

use std::sync::{Arc, Mutex};

use hmac::{Hmac, Mac};
use sha2::Sha256;

use super::{Devices, PairingLinkProof, hash};
use crate::CredentialRuntime;

pub(crate) fn devices() -> (Devices, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
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
    let path = directory.path().join("events.sqlite");
    let devices = Devices::open(path.to_str().unwrap(), runtime).unwrap();
    (devices, directory)
}

pub(crate) fn proof(token: &str, device_id: &str, account: &str) -> PairingLinkProof {
    let mut mac =
        <Hmac<Sha256> as hmac::digest::KeyInit>::new_from_slice(hash(token).as_bytes()).unwrap();
    mac.update(format!("ace-link/v1\n{device_id}\n{account}").as_bytes());
    PairingLinkProof {
        device_id: device_id.to_owned(),
        proof: base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            mac.finalize().into_bytes(),
        ),
    }
}

pub(crate) fn cap_linked(linked: Vec<String>, limit: usize) -> (Vec<String>, usize) {
    let cut = linked.len().saturating_sub(limit);
    (linked.into_iter().take(limit).collect(), cut)
}
