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
