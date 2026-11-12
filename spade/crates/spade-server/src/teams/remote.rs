//! How Spade reaches the person's other machines (ADR 0132): through its local daemon, which
//! forwards one request to a named machine's Spade inbox. Injected, so tests put a fake daemon
//! between two Spades.

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A linked machine the daemon can call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Machine {
    pub host_id: String,
    pub name: String,
    pub online: bool,
}

/// Why a request to another machine got no answer from its Spade.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RemoteError {
    /// No linked machine has that host id.
    #[error("no linked machine {0}")]
    UnknownMachine(String),
    /// Nothing was sent: the machine, its daemon or this one can't be reached.
    #[error("the machine can't be reached")]
    Offline,
    /// Lost after sending: it may have arrived.
    #[error("the connection was lost after sending")]
    Disconnected,
    /// That machine (or this daemon) said no, for good.
    #[error("{0}")]
    Refused(String),
}

impl RemoteError {
    /// Worth trying again later: the machine may come back.
    pub fn retry(&self) -> bool {
        matches!(self, Self::Offline | Self::Disconnected)
    }
}

pub trait Remote: Send + Sync {
    /// The linked machines.
    fn machines(&self) -> BoxFuture<'_, Result<Vec<Machine>, RemoteError>>;
    /// One inbox request to `machine` (a host id): Spade's status there and its JSON answer.
    fn call(&self, machine: &str, request: Value) -> BoxFuture<'_, Result<(u16, Value), RemoteError>>;
}

/// The machines in a `spade.machines.result`.
pub fn machines_from(answer: &Value) -> Vec<Machine> {
    answer["machines"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    Some(Machine {
                        host_id: m["hostId"].as_str()?.to_owned(),
                        name: m["name"].as_str().unwrap_or("another machine").to_owned(),
                        online: m["status"] == "online",
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A `spade.remote.result`'s `result`: Spade's status and answer there, or why there is none.
/// A refusal because Spade there is off or away is worth retrying, like an offline machine.
pub fn answer_from(result: &Value) -> Result<(u16, Value), RemoteError> {
    match result["kind"].as_str() {
        Some("response") => Ok((
            result["status"].as_u64().unwrap_or(502) as u16,
            result["body"].clone(),
        )),
        Some("error") => {
            let message = result["message"].as_str().unwrap_or("").to_owned();
            match result["code"].as_str() {
                Some("unknown_machine") => Err(RemoteError::UnknownMachine(message)),
                Some("offline") => Err(RemoteError::Offline),
                Some("disconnected") => Err(RemoteError::Disconnected),
                Some("refused") if message.starts_with("unavailable") => Err(RemoteError::Offline),
                _ => Err(RemoteError::Refused(message)),
            }
        }
        _ => Err(RemoteError::Offline),
    }
}
