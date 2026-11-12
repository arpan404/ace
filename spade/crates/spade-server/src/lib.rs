//! Spade's server: the local API ([`api`]) over the engine ([`engine`]) that runs turns.

pub mod api;
mod atomic;
pub mod clock;
pub mod config;
pub mod engine;
pub mod home;
pub mod images;
pub mod learning;
pub mod presets;
pub mod proof;
pub mod research;
pub mod routines;
pub mod startup;
pub mod tools;
pub mod workspace;

use std::future::Future;

use tokio::net::TcpListener;

pub use api::{AppState, router};

/// Serves the API on `listener` until `shutdown` resolves, then finishes open requests.
pub async fn serve(
    listener: TcpListener,
    state: AppState,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let (closing, closed) = tokio::sync::watch::channel(false);
    let app = router(state).layer(axum::Extension(api::Closing(closed)));
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown.await;
            // Live streams end now, so open ones never hold shutdown up.
            let _ = closing.send(true);
        })
        .await
}
