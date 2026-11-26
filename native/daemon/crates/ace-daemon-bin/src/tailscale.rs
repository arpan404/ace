// SPDX-License-Identifier: Apache-2.0
//! Tailscale: this machine's 100.x address and MagicDNS name, and the
//! browser-trusted certificate Tailscale issues for it
//! (`apps/daemon/src/network.ts`, `tailscale-certificate.ts`).
//!
//! The daemon serves ace's pinned certificate until a valid Tailscale
//! certificate is fetched, then serves that one for its `ts.net` name through the
//! SNI resolver, refreshing twice a day. A failed fetch keeps the pinned
//! certificate and is retried, exactly as `trustedCertificate` does.
//!
//! TypeScript cases ported: `apps/daemon/src/tailscale-certificate.test.ts`
//! ("takes a chain and its key and reads when it expires", "refuses a certificate
//! for another name", "refuses an expired certificate", "refuses a key that is
//! not the certificate's") and `apps/daemon/src/network.test.ts` ("reads the 100.x
//! address and MagicDNS name from tailscale status", "gives the pairing guidance
//! when Tailscale is not running").

use std::path::Path;
use std::time::Duration;

use serde_json::Value;

mod certificate;
#[cfg(test)]
mod tests;

use certificate::{host_checked, split_pem};

/// The machine's Tailscale address and, when MagicDNS is on, its `ts.net` name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tailnet {
    pub address: std::net::IpAddr,
    pub name: Option<String>,
}

/// The guidance `remoteListener` gives when Tailscale cannot be read.
const GUIDANCE: &str = "Cannot detect Tailscale address. Start Tailscale, or start ace with ACE_LISTEN=lan and ACE_REMOTE_PORT=4243, then run tailscale serve --tcp=443 tcp://localhost:4243. Replace the pairing URL authority with the Serve hostname:443 and keep its fragment to preserve the ace public-key pin.";

/// `tailscale status --json`, read for the address and MagicDNS name.
pub async fn status() -> Result<Tailnet, String> {
    let output = run(&["status", "--json"], Duration::from_secs(5)).await?;
    let value: Value = serde_json::from_str(&output).map_err(|_| GUIDANCE.to_owned())?;
    if value.get("BackendState").and_then(Value::as_str) != Some("Running") {
        return Err(GUIDANCE.to_owned());
    }
    let addresses = value
        .get("TailscaleIPs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|text| text.parse::<std::net::IpAddr>().ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let address = addresses
        .iter()
        .find(|address| address.is_ipv4())
        .copied()
        .ok_or_else(|| GUIDANCE.to_owned())?;
    // MagicDNS off means the name is not reachable: links keep the 100.x address.
    let magic_dns = value
        .get("CurrentTailnet")
        .and_then(|tailnet| tailnet.get("MagicDNSEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let name = if magic_dns {
        value
            .get("Self")
            .and_then(|me| me.get("DNSName"))
            .and_then(Value::as_str)
            .map(|name| name.trim().trim_end_matches('.').to_ascii_lowercase())
            .filter(|name| name.contains('.') && name.parse::<std::net::IpAddr>().is_err())
    } else {
        None
    };
    Ok(Tailnet { address, name })
}

/// `tailscale cert --cert-file - --key-file - -- <name>`: the chain and key as PEM.
pub async fn certificate(name: &str) -> Result<String, String> {
    run(
        &["cert", "--cert-file", "-", "--key-file", "-", "--", name],
        Duration::from_secs(120),
    )
    .await
}

/// A chain and its key, as the SNI resolver takes them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailscalePem {
    pub chain_pem: String,
    pub key_pem: String,
}

/// `parseTailscaleCertificate`: the first certificate chain and its key, only
/// when the leaf names `name` and is valid now. Undefined otherwise, so a bad
/// issuance never replaces a working certificate.
pub async fn parse(output: &str, name: &str, home: &Path) -> Option<TailscalePem> {
    let (chain, key) = split_pem(output)?;
    if !host_checked(&chain, name, home).await {
        return None;
    }
    // `certificate.checkPrivateKey`: re-encoding refuses a key that is not the
    // leaf's.
    ace_transport::TlsIdentity::from_pem(chain.as_bytes(), key.as_bytes()).ok()?;
    Some(TailscalePem {
        chain_pem: chain,
        key_pem: key,
    })
}

/// Run `tailscale` with `args`, its stdout when it succeeds.
async fn run(args: &[&str], timeout: Duration) -> Result<String, String> {
    let child = tokio::process::Command::new("tailscale")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(timeout, child)
        .await
        .map_err(|_| GUIDANCE.to_owned())?
        .map_err(|_| GUIDANCE.to_owned())?;
    if !output.status.success() {
        return Err(GUIDANCE.to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Fetch Tailscale's certificate for `name` now, push it to `resolver`, and
/// refresh twice a day; a failed fetch keeps the pinned certificate and is
/// retried in ten minutes (`trustedCertificate`'s `refreshMs` and `retryMs`).
pub fn spawn_refresh(
    resolver: std::sync::Arc<ace_transport::SniResolver>,
    name: String,
    home: std::path::PathBuf,
    log: std::sync::Arc<crate::log::Log>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let wait = match certificate(&name).await {
                Ok(output) => match parse(&output, &name, &home).await {
                    Some(pem) => {
                        match ace_transport::TlsIdentity::from_pem(
                            pem.chain_pem.as_bytes(),
                            pem.key_pem.as_bytes(),
                        ) {
                            Ok(identity) => {
                                resolver.set_trusted(&name, identity);
                                log.log(
                                    "info",
                                    "Serving Tailscale's certificate",
                                    serde_json::json!({"name": name}),
                                );
                                Duration::from_secs(12 * 60 * 60)
                            }
                            Err(error) => {
                                log.log(
                                    "warn",
                                    "Tailscale's certificate could not be used",
                                    serde_json::json!({"error": error.to_string()}),
                                );
                                Duration::from_secs(10 * 60)
                            }
                        }
                    }
                    None => {
                        log.log(
                            "warn",
                            "Tailscale returned no usable certificate",
                            serde_json::json!({"name": name}),
                        );
                        Duration::from_secs(10 * 60)
                    }
                },
                Err(error) => {
                    log.log(
                        "warn",
                        "Tailscale's certificate could not be fetched",
                        serde_json::json!({"name": name, "error": error}),
                    );
                    Duration::from_secs(10 * 60)
                }
            };
            tokio::time::sleep(wait).await;
        }
    })
}
