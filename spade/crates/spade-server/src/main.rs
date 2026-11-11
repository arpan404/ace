use std::sync::Arc;
use std::time::Duration;

use spade_ace::{AceConfig, AceSkills, AceTools};
use spade_fetch::{Fetcher, Policy};
use spade_keys::{KeyStore, Keys};
use spade_models::{Catalog, Models};
use spade_search::{Search, SearchConfig};
use spade_server::api::AppState;
use spade_server::clock::{SystemClock, SystemIds, local_offset_seconds};
use spade_server::config::Config;
use spade_server::engine::{Engine, Limits, Setup};
use spade_server::home::{DEFAULT_MODELS, DEFAULT_SEARCH, Home, HomeError, new_token};
use spade_server::tools::{
    AceLibrary, AceSource, SkillLibrary, SkillLoad, SkillSearch, Todo, Tool, Toolbox, WebFetch,
    WebSearch,
};
use spade_store::Store;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

/// Exit code when another Spade holds the data folder (docs/ace-integration.md).
const BUSY: u8 = 3;

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(Failure::Busy(error)) => {
            tracing::error!(%error);
            std::process::ExitCode::from(BUSY)
        }
        Err(Failure::Other(error)) => {
            tracing::error!(%error, "spade could not start");
            std::process::ExitCode::FAILURE
        }
    }
}

enum Failure {
    Busy(HomeError),
    Other(String),
}

fn other(error: impl std::fmt::Display) -> Failure {
    Failure::Other(error.to_string())
}

async fn run() -> Result<(), Failure> {
    let env = |key: &str| std::env::var(key).ok();
    let config = Config::from_env(env).map_err(other)?;
    let home = Home::open(&config.data_dir).map_err(|e| match e {
        HomeError::Busy(_) => Failure::Busy(e),
        e => other(e),
    })?;

    let keychain = match KeyStore::os() {
        Ok(store) => Some(store),
        Err(error) => {
            tracing::warn!(%error, "no keychain; endpoint keys come from the environment only");
            None
        }
    };
    let lookup = keychain.clone();
    let keys = Keys::keychain_then_env(
        move |endpoint| lookup.as_ref().and_then(|k| k.get(endpoint).ok().flatten()),
        |var| std::env::var(var).ok(),
    );

    let models_path = match env("SPADE_MODEL_CATALOG").filter(|v| !v.trim().is_empty()) {
        Some(path) => path.into(),
        None => home
            .file_or_default("models.json", DEFAULT_MODELS)
            .map_err(other)?,
    };
    let models =
        Models::new(Catalog::load(&models_path).map_err(other)?, keys.clone()).map_err(other)?;
    let search_path = home
        .file_or_default("search.json", DEFAULT_SEARCH)
        .map_err(other)?;
    let search = Search::new(
        SearchConfig::load(&search_path).map_err(other)?,
        keys,
        Duration::from_secs(10),
    )
    .map_err(other)?;
    let fetcher = Fetcher::new(Policy::default(), Duration::from_secs(30));
    let mut core: Vec<Arc<dyn Tool>> = vec![
        Arc::new(WebSearch(Arc::new(search))),
        Arc::new(WebFetch(Arc::new(fetcher))),
        Arc::new(Todo),
    ];
    // ace's tools and skill library, when the daemon started Spade (docs/ace-integration.md).
    let ace = match AceConfig::from_env(env) {
        Ok(ace) => Some(ace),
        Err(error) => {
            tracing::warn!(%error, "running without ace's tools and skills");
            None
        }
    };
    let mut skills: Option<Arc<dyn SkillLibrary>> = None;
    let mut source = None;
    if let Some(ace) = ace {
        let library: Arc<dyn SkillLibrary> =
            Arc::new(AceLibrary(Arc::new(AceSkills::new(ace.skills))));
        core.push(Arc::new(SkillSearch(library.clone())));
        core.push(Arc::new(SkillLoad(library.clone())));
        skills = Some(library);
        source = Some(AceSource::start(Arc::new(AceTools::new(ace.tools))));
    }
    let mut tools = Toolbox::new(core);
    if let Some(source) = source {
        tools = tools.with_source(source);
    }

    let engine = Engine::open(Setup {
        store: Store::open(&home.database()).map_err(other)?,
        models,
        tools,
        clock: Arc::new(SystemClock),
        ids: Arc::new(SystemIds),
        daily_cap_micros: spade_core::spending::usd_to_micros(config.daily_cap_usd),
        utc_offset_seconds: local_offset_seconds(),
        limits: Limits::default(),
        skills,
    })
    .map_err(other)?;

    let token = new_token();
    home.write_token(&token).map_err(other)?;
    let listener = TcpListener::bind(config.listen).await.map_err(other)?;
    let address = listener.local_addr().map_err(other)?;
    home.write_server_json(address, std::process::id())
        .map_err(other)?;
    tracing::info!(%address, "spade listening");

    let state = AppState {
        engine,
        token: token.into(),
        keys: keychain,
    };
    let served = spade_server::serve(listener, state, shutdown_signal()).await;
    home.clear_server_json();
    served.map_err(other)?;
    tracing::info!("spade stopped");
    Ok(())
}

/// Resolves on Ctrl-C, or on SIGTERM from whatever started Spade (the ace daemon or systemd).
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "could not listen for Ctrl-C");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!(%error, "could not listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
