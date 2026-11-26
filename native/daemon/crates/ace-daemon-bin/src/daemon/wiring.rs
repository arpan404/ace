// SPDX-License-Identifier: Apache-2.0
//! The pieces the start composes around the listeners: the home's TLS identity,
//! the bytes `ace start` prints, and the bind failures the CLI names.

use std::path::Path;

use crate::config::Listen;
use crate::transport::{RemoteIdentity, Transport};

use super::Output;

/// The remote identity the home holds: `tls/cert.pem` and `tls/key.pem`.
pub(super) fn remote_identity(
    data_dir: &Path,
    listen: Listen,
    port: u16,
) -> Option<RemoteIdentity> {
    if listen != Listen::Lan {
        // Tailscale's certificate and 100.x address are a separate listener the
        // relay work brings; LAN is the static one this slice serves.
        return None;
    }
    let directory = data_dir.join("tls");
    let cert_pem = std::fs::read(directory.join("cert.pem")).ok()?;
    let key_pem = std::fs::read(directory.join("key.pem")).ok()?;
    Some(RemoteIdentity {
        cert_pem,
        key_pem,
        port,
    })
}

/// `startedJson` and `startedText`: the bytes the launcher and the CLI read.
pub(super) fn print_started(transport: &Transport, token_path: &Path, output: Output) {
    let remote = transport.remote.map(|addr| format!("https://{addr}"));
    let text = match output {
        Output::Json => {
            let mut object = format!(
                "{{\"running\":true,\"url\":{},\"tokenPath\":{}",
                serde_json::Value::String(transport.url()),
                serde_json::Value::String(token_path.display().to_string())
            );
            if let Some(remote) = &remote {
                object.push_str(&format!(
                    ",\"remoteUrl\":{}",
                    serde_json::Value::String(remote.clone())
                ));
            }
            object.push('}');
            object
        }
        Output::Text => format!(
            "ace daemon: {}\nToken file: {}{}",
            transport.url(),
            token_path.display(),
            remote
                .as_ref()
                .map(|remote| format!("\nRemote: {remote}"))
                .unwrap_or_default()
        ),
    };
    println!("{text}");
}

/// `addressInUse`: the bind error's own kind says the port is taken.
pub(super) fn address_in_use(error: &crate::transport::TransportError) -> bool {
    match error {
        crate::transport::TransportError::Loopback(ace_transport::TransportError::Bind {
            source,
            ..
        }) => source.kind() == std::io::ErrorKind::AddrInUse,
        _ => false,
    }
}

pub(super) fn fields_value(fields: Vec<(&'static str, String)>) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    for (name, value) in fields {
        object.insert(name.to_owned(), value.into());
    }
    serde_json::Value::Object(object)
}
