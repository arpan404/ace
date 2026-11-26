// SPDX-License-Identifier: Apache-2.0
//! The pieces the start composes around the listeners: the home's TLS identity,
//! the bytes `ace start` prints, and the bind failures the CLI names.

use std::path::Path;

use crate::transport::{RemoteInfo, RemotePlan, Transport};

use super::Output;

/// The remote listener this start should run, or none for local only.
///
/// LAN binds every interface and advertises the configured host or the machine's
/// LAN address; Tailscale binds its 100.x address and advertises it until the
/// ts.net certificate is served. `loadIdentity` makes the pinned identity on a
/// fresh home, as TypeScript does, so LAN works with no prior setup.
pub(super) async fn remote_plan(
    config: &crate::config::Config,
) -> Result<Option<RemotePlan>, String> {
    use crate::config::Listen;
    if config.listen == Listen::Local {
        return Ok(None);
    }
    let identity = crate::identity::load(&config.data_dir)
        .await
        .map_err(|error| error.to_string())?;
    let (advertised, tailnet) = match config.listen {
        Listen::Lan => {
            let host = config
                .advertise_host
                .clone()
                .filter(|host| !host.is_empty())
                .or_else(lan_address)
                .ok_or_else(|| {
                    "No LAN address found. Set ACE_ADVERTISE_HOST to the host's LAN address."
                        .to_owned()
                })?;
            (host, None)
        }
        Listen::Tailscale => {
            let status = crate::tailscale::status().await?;
            (status.address.to_string(), status.name)
        }
        Listen::Local => return Ok(None),
    };
    Ok(Some(RemotePlan {
        listen: config.listen,
        home: config.data_dir.clone(),
        identity,
        advertised,
        port: config.remote_port,
        tailnet,
    }))
}

/// The machine's LAN address, as the kernel would pick it for an outbound
/// connection: no packet is sent and no interface list is read.
fn lan_address() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let address = socket.local_addr().ok()?.ip();
    (!address.is_unspecified()).then(|| address.to_string())
}

/// `startedJson` and `startedText`: the bytes the launcher and the CLI read.
pub(super) fn print_started(transport: &Transport, token_path: &Path, output: Output) {
    let remote: Option<&RemoteInfo> = transport.remote.as_ref();
    let text = match output {
        Output::Json => {
            let mut object = format!(
                "{{\"running\":true,\"url\":{},\"tokenPath\":{}",
                serde_json::Value::String(transport.url()),
                serde_json::Value::String(token_path.display().to_string())
            );
            if let Some(remote) = remote {
                object.push_str(&format!(
                    ",\"remoteUrl\":{},\"fingerprint\":{}",
                    serde_json::Value::String(remote.url.clone()),
                    serde_json::Value::String(remote.fingerprint.clone())
                ));
            }
            object.push('}');
            object
        }
        Output::Text => match remote {
            Some(remote) => format!(
                "ace daemon: {}\nToken file: {}\nRemote: {}\nPublic-key SHA-256: {}",
                transport.url(),
                token_path.display(),
                remote.url,
                remote.fingerprint
            ),
            None => format!(
                "ace daemon: {}\nToken file: {}",
                transport.url(),
                token_path.display()
            ),
        },
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
