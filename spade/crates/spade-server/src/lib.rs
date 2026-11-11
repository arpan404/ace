//! Spade's server: the local API ([`api`]) over the engine ([`engine`]) that runs turns.

pub mod api;
pub mod clock;
pub mod config;
pub mod engine;
pub mod home;
pub mod tools;

use std::future::Future;

use tokio::net::TcpListener;

pub use api::{AppState, router};

/// Serves the API on `listener` until `shutdown` resolves, then finishes open requests.
pub async fn serve(
    listener: TcpListener,
    state: AppState,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown)
        .await
}
