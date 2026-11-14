// SPDX-License-Identifier: Apache-2.0
//! Transport only. Admission and handshake remain the daemon's responsibility.
mod cipher;
mod flow;
mod memory;
mod message;
mod relay;
pub use cipher::{CipherState, MAX_MESSAGE};
pub use flow::{CREDIT_FLAG, FLOW_WINDOW, FlowCredit, credit_fragment, fragment_cost, read_credit};
pub use memory::install_payload_free_panic_hook;
pub use message::{Message, MessageAssembler};
pub use relay::{Fragment, FragmentKind, Fragments, REKEY_INTERVAL, RelayStream};

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Closed,
    TooLarge,
    Authentication,
    InvalidKeyBlock,
    InvalidFragment,
    InvalidCredit,
    WindowExceeded,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "media transport: {self:?}")
    }
}
impl std::error::Error for Error {}

#[cfg(test)]
mod tests;
