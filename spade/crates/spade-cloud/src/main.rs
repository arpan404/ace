//! `spade-cloud`: serves Spade Cloud on `$PORT` until SIGTERM or Ctrl-C, then lets requests in
//! flight finish. Configured only through the environment (`spade/docs/cloud.md`). TLS ends at
//! the hosting platform's edge; outbound requests use rustls.

use std::sync::Arc;
use std::time::Duration;

use spade_cloud::{Service, Setup, apps, config::Config, keys::HttpKeys, system_clock};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    if let Err(why) = run().await {
        tracing::error!(reason = %why, "spade-cloud stopped");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let env = |name: &str| std::env::var(name).ok();
    let config = Config::from_env(&env)?;
    let text = match &config.apps_file {
        Some(path) => std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?,
        None => apps::SHIPPED.to_owned(),
    };
    let apps = apps::configure(apps::parse(&text)?, &env);
    for configured in &apps {
        tracing::info!(
            app = %configured.app.id,
            ready = configured.client.is_some(),
            "app listed"
        );
    }
    let service = Service::new(Setup {
        apps,
        public_url: config.public_url.clone(),
        keys: Arc::new(HttpKeys::new(&config.account_origin)),
        clock: system_clock(),
        random: Arc::new(ring::rand::SystemRandom::new()),
        address_header: config.address_header.clone(),
        maker_timeout: Duration::from_secs(15),
        account_budget: Setup::ACCOUNT_BUDGET,
        address_budget: Setup::ADDRESS_BUDGET,
    });
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port))
        .await
        .map_err(|e| format!("could not listen on {}: {e}", config.port))?;
    tracing::info!(port = config.port, public_url = %config.public_url, "listening");
    spade_cloud::serve(listener, service, shutdown())
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!("stopped");
    Ok(())
}

async fn shutdown() {
    let interrupt = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut terminate =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(_) => {
                    let _ = interrupt.await;
                    return;
                }
            };
        tokio::select! {
            _ = interrupt => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = interrupt.await;
    }
    tracing::info!("stopping: letting requests in flight finish");
}
