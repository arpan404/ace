//! Spade's egress proxy and the network policy it holds each bot's runs to (ADR 0167
//! decision 3).

pub mod hosts;
pub mod log;
pub mod proxy;

pub use hosts::{DEFAULTS, Mode, NetworkPolicy, Verdict};
pub use log::{EgressLog, Entry};
pub use proxy::{Clock, Proxy, Resolve, SystemResolver, Ticket, Usage};
