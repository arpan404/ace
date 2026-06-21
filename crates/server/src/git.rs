mod error;
mod routes;
mod service;

#[cfg(test)]
mod tests;

pub use error::GitApiError;
pub use routes::{router, router_with_state};
pub use service::{GitApiState, GitDiffResponse, GitService};
