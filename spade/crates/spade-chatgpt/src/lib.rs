//! Spade signs in to OpenAI with a ChatGPT account itself (ADR 0213): a browser sign-in with
//! PKCE back to a loopback address, or a device code; the tokens kept in the OS keychain only,
//! refreshed in Spade, never logged, synced or returned. Calls on the account are
//! `spade-models`' (`chatgpt` there); this crate only signs in and hands out access tokens.

pub mod accounts;
pub mod claims;
pub mod flows;
pub mod loopback;
pub mod oauth;

use std::sync::Arc;
use std::time::Duration;

pub use accounts::{Accounts, BearerError};
pub use claims::Account;
pub use flows::{Finish, FlowView, Flows, Method, SignedIn};
pub use oauth::Tokens;

/// The current time in Unix seconds: the system's in Spade, fixed in tests.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// OpenAI's public client id for its Codex sign-in.
pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

/// Where the sign-in runs, and how long one may wait.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// OpenAI's sign-in server, without a trailing `/`.
    pub issuer: String,
    pub client_id: String,
    /// The loopback port the browser comes back to: the one OpenAI registered for this client.
    pub callback_port: u16,
    /// Sent as `originator`: Spade.
    pub originator: String,
    /// How long a sign-in waits for the person.
    pub wait: Duration,
    /// Where a signed-in account's calls go: the ChatGPT backend's Codex routes, ending in `/`.
    pub backend: String,
}

impl Config {
    /// OpenAI's own sign-in.
    pub fn openai() -> Self {
        Self {
            issuer: "https://auth.openai.com".to_owned(),
            client_id: CLIENT_ID.to_owned(),
            callback_port: 1455,
            originator: "spade".to_owned(),
            wait: Duration::from_secs(15 * 60),
            backend: "https://chatgpt.com/backend-api/codex/".to_owned(),
        }
    }
}
