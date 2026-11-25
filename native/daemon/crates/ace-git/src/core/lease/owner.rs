// SPDX-License-Identifier: Apache-2.0
//! Liveness probes of a lease's owner (`packages/git/src/lease-owner.ts`).
//! One unreferenced local endpoint per process, queried only for a lease this
//! process did not write itself. A probe is evidence of liveness, never of
//! cleanup: `gone` is definitive, every other failure stays `unknown`.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use ace_json::{Map, Value};

use crate::core::lease::journal::{LeaseRecord, OwnerEndpoint};
use crate::core::lease::state::LeaseOwnerState;

const PROBE_TIMEOUT: Duration = Duration::from_secs(1);
/// One query is a token and an id; a reply is one word.
const QUERY_LIMIT: usize = 512;
const REPLY_LIMIT: usize = 32;

/// A process's ownership endpoint and the token its leases carry.
#[derive(Debug, Clone)]
pub struct LeaseOwner {
    pub port: u16,
    pub token: String,
}

/// The states this process reports for its own leases.
pub type OwnerStateFn = Arc<dyn Fn(&str) -> LeaseOwnerState + Send + Sync>;

fn process_owner() -> &'static OnceLock<Option<LeaseOwner>> {
    static OWNER: OnceLock<Option<LeaseOwner>> = OnceLock::new();
    &OWNER
}

/// Whether `lease` was written by this process: its endpoint carries this process's token.
pub fn owned_by_this_process(lease: &LeaseRecord) -> bool {
    let Some(owner) = process_owner().get().and_then(Option::as_ref) else {
        return false;
    };
    lease
        .owner
        .as_ref()
        .is_some_and(|endpoint| endpoint.token == owner.token)
}

/// One endpoint per process, created only when a lease is first written.
/// `id` supplies the token; `state` answers this process's own leases.
pub fn lease_owner(id: &str, state: OwnerStateFn) -> Option<LeaseOwner> {
    process_owner()
        .get_or_init(|| start_endpoint(id, state))
        .clone()
}

fn start_endpoint(id: &str, state: OwnerStateFn) -> Option<LeaseOwner> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    let token = id.to_owned();
    let answer_token = token.clone();
    std::thread::Builder::new()
        .name("ace-git-lease-owner".to_owned())
        .spawn(move || serve(listener, answer_token, state))
        .ok()?;
    Some(LeaseOwner { port, token })
}

fn serve(listener: TcpListener, token: String, state: OwnerStateFn) {
    for incoming in listener.incoming() {
        let Ok(socket) = incoming else {
            return;
        };
        let _ = socket.set_read_timeout(Some(PROBE_TIMEOUT));
        let _ = socket.set_write_timeout(Some(PROBE_TIMEOUT));
        let reply = answer(socket, &token, &state);
        if let Some(reply) = reply {
            let mut socket = reply.0;
            let _ = socket.write_all(reply.1.as_bytes());
            let _ = socket.flush();
        }
    }
}

fn answer(mut socket: TcpStream, token: &str, state: &OwnerStateFn) -> Option<(TcpStream, String)> {
    let mut input = String::new();
    let mut buffer = [0u8; 256];
    loop {
        match socket.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                input.push_str(&String::from_utf8_lossy(&buffer[..read]));
                if input.len() > QUERY_LIMIT {
                    return None;
                }
                if input.ends_with('\n') {
                    break;
                }
            }
            Err(_) => return None,
        }
    }
    let parsed = ace_json::parse(input.trim_end()).ok()?;
    let Value::Object(map) = parsed else {
        return Some((socket, "unknown".to_owned()));
    };
    let query_token = text(&map, "token");
    let query_id = text(&map, "id");
    match (query_token, query_id) {
        (Some(query_token), Some(query_id)) if query_token == token => Some((
            socket,
            match state(&query_id) {
                LeaseOwnerState::Held | LeaseOwnerState::Running => "active",
                LeaseOwnerState::Quarantined => "quarantined",
                _ => "unknown",
            }
            .to_owned(),
        )),
        (Some(_), Some(_)) => Some((socket, "foreign".to_owned())),
        _ => Some((socket, "unknown".to_owned())),
    }
}

fn text(map: &Map, key: &str) -> Option<String> {
    match map.get(key) {
        Some(Value::String(text)) => Some(text.to_string_lossy().into_owned()),
        _ => None,
    }
}

/// Liveness only, never cleanup proof. Reused ports cannot answer a different token.
/// One 1 s budget through the injected scheduler, as TypeScript gives the probe.
pub async fn query_lease_owner(
    lease: &LeaseRecord,
    ports: &dyn crate::core::lease::LeasePorts,
) -> LeaseOwnerState {
    let Some(endpoint) = lease.owner.clone() else {
        return LeaseOwnerState::Unknown;
    };
    let id = lease.id.clone();
    let probe = tokio::task::spawn_blocking(move || query_blocking(&endpoint, &id));
    tokio::select! {
        biased;
        () = ports.pause(PROBE_TIMEOUT.as_millis() as u64) => LeaseOwnerState::Unknown,
        outcome = probe => match outcome {
            Ok(state) => state,
            Err(_) => LeaseOwnerState::Unknown,
        },
    }
}

fn query_blocking(endpoint: &OwnerEndpoint, id: &str) -> LeaseOwnerState {
    let mut socket = match TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], endpoint.port)),
        PROBE_TIMEOUT,
    ) {
        Ok(socket) => socket,
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
            return LeaseOwnerState::Gone;
        }
        Err(_) => return LeaseOwnerState::Unknown,
    };
    let _ = socket.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = socket.set_write_timeout(Some(PROBE_TIMEOUT));
    let mut query = Map::new();
    query.insert(
        ace_json::JsString::from("token"),
        Value::from(endpoint.token.as_str()),
    );
    query.insert(ace_json::JsString::from("id"), Value::from(id));
    let mut line = ace_json::to_string(&Value::Object(query));
    line.push('\n');
    if socket.write_all(line.as_bytes()).is_err() {
        return LeaseOwnerState::Unknown;
    }
    let mut input = String::new();
    let mut buffer = [0u8; 64];
    loop {
        match socket.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                input.push_str(&String::from_utf8_lossy(&buffer[..read]));
                if input.len() > REPLY_LIMIT {
                    return LeaseOwnerState::Unknown;
                }
            }
            Err(_) => return LeaseOwnerState::Unknown,
        }
    }
    match input.as_str() {
        "active" => LeaseOwnerState::Active,
        "quarantined" => LeaseOwnerState::Quarantined,
        "unknown" => LeaseOwnerState::Unknown,
        "foreign" => LeaseOwnerState::Gone,
        _ => LeaseOwnerState::Unknown,
    }
}

/// A port nothing listens on: the endpoint of a daemon that has stopped.
#[cfg(test)]
pub(crate) fn stopped_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("address").port();
    drop(listener);
    port
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lease(owner: Option<OwnerEndpoint>) -> LeaseRecord {
        LeaseRecord {
            version: 1,
            id: "00000000-0000-4000-8000-000000000000".to_owned(),
            root: "/repos/ace".to_owned(),
            owner,
            roots: vec!["/repos/ace".to_owned()],
        }
    }

    #[tokio::test]
    async fn a_stopped_owner_is_gone_and_a_lease_without_one_is_unknown() {
        let stopped = lease(Some(OwnerEndpoint {
            port: stopped_port(),
            token: "00000000-0000-4000-8000-000000000001".to_owned(),
        }));
        let ports = crate::core::lease::TestPorts::default();
        assert_eq!(
            query_lease_owner(&stopped, &ports).await,
            LeaseOwnerState::Gone
        );
        assert_eq!(
            query_lease_owner(&lease(None), &ports).await,
            LeaseOwnerState::Unknown
        );
    }

    #[tokio::test]
    async fn this_process_answers_for_its_own_token_and_calls_another_token_foreign() {
        let id = format!(
            "00000000-0000-4000-8000-{:012}",
            std::process::id() % 1_000_000
        );
        let owner = lease_owner(
            &id,
            Arc::new(|id: &str| {
                if id == "held" {
                    LeaseOwnerState::Quarantined
                } else {
                    LeaseOwnerState::Running
                }
            }),
        )
        .expect("endpoint");
        let ports = crate::core::lease::TestPorts::default();
        let mine = lease(Some(OwnerEndpoint {
            port: owner.port,
            token: owner.token.clone(),
        }));
        assert!(owned_by_this_process(&mine));
        assert_eq!(
            query_lease_owner(&mine, &ports).await,
            LeaseOwnerState::Active
        );
        let held = LeaseRecord {
            id: "held".to_owned(),
            ..mine.clone()
        };
        assert_eq!(
            query_lease_owner(&held, &ports).await,
            LeaseOwnerState::Quarantined
        );
        let foreign = lease(Some(OwnerEndpoint {
            port: owner.port,
            token: "00000000-0000-4000-8000-0000000000ff".to_owned(),
        }));
        assert!(!owned_by_this_process(&foreign));
        assert_eq!(
            query_lease_owner(&foreign, &ports).await,
            LeaseOwnerState::Gone
        );
    }
}
