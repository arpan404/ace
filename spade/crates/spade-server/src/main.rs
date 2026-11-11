use std::sync::Arc;
use std::time::Duration;

use spade_fetch::{Fetcher, Policy};
use spade_keys::{KeyStore, Keys};
use spade_models::{Catalog, Models};
use spade_search::{Search, SearchConfig};
use spade_server::api::AppState;
use spade_server::clock::{SystemClock, SystemIds, local_offset_seconds};
use spade_server::config::Config;
use spade_server::engine::{Engine, Limits, Setup};
use spade_server::home::{DEFAULT_MODELS, DEFAULT_SEARCH, Home, HomeError, new_token};
use spade_server::images::ImageStore;
use spade_server::tools::{
    AceLink, AceTarget, Retry, SkillLibrary, SkillLoad, SkillSearch, Todo, Tool, ToolSource,
    Toolbox, WebFetch, WebSearch,
};
use spade_store::Store;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Exit code when another Spade holds the data folder (docs/ace-integration.md).
const BUSY: u8 = 3;

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|flag| flag == "--version") {
        println!("{}", spade_server::home::VERSION);
        return std::process::ExitCode::SUCCESS;
    }
    if let Some(flag) = args.first()
        && flag == "--check-migrations"
    {
        return check_migrations(args.get(1));
    }
    // The HTML parser's own logs carry page text, so they are dropped by a separate layer that no
    // RUST_LOG setting can turn back on.
    tracing_subscriber::registry()
        // Plain text when not on a terminal: the service writes to a log file.
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout())),
        )
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(filter_fn(|meta| !spade_fetch::is_parser_log(meta.target())))
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

/// `spade-server --check-migrations <path>`: an updater asks whether this build can open a
/// snapshot of Spade's database (docs/ace-integration.md, "Updates"). Migrates and checks that
/// file only; never touches the data folder. Exit 0 if usable, else 1 with one line saying why.
fn check_migrations(path: Option<&std::ffi::OsString>) -> std::process::ExitCode {
    let Some(path) = path else {
        eprintln!("usage: spade-server --check-migrations <path to a copy of spade.sqlite>");
        return std::process::ExitCode::from(2);
    };
    match Store::check(std::path::Path::new(path)) {
        Ok(()) => {
            println!("ok");
            std::process::ExitCode::SUCCESS
        }
        Err(why) => {
            eprintln!("{why}");
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
    // ace's tools and skill library, found from ace's home with the grant ace handed over (or
    // the SPADE_ACE_* variables in development). Absent while ace is away.
    let ace = match AceTarget::from_env(env) {
        Some(target) => Some(AceLink::start(target, keychain.clone(), Retry::default())),
        None => {
            tracing::warn!("SPADE_ACE_HOME is not set; running without ace's tools and skills");
            None
        }
    };
    let fetcher = Fetcher::new(Policy::default(), Duration::from_secs(30));
    let mut core: Vec<Arc<dyn Tool>> = vec![
        Arc::new(WebSearch {
            search: Arc::new(search),
            ace_fallback: ace.is_some(),
        }),
        Arc::new(WebFetch(Arc::new(fetcher))),
        Arc::new(Todo),
    ];
    let mut skills: Option<Arc<dyn SkillLibrary>> = None;
    if let Some(link) = &ace {
        let library: Arc<dyn SkillLibrary> = link.clone();
        core.push(Arc::new(SkillSearch(library.clone())));
        core.push(Arc::new(SkillLoad(library.clone())));
        skills = Some(library);
    }
    let mut tools = Toolbox::new(core);
    if let Some(link) = &ace {
        tools = tools.with_source(link.clone() as Arc<dyn ToolSource>);
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
        images: ImageStore::open(&home.images()).map_err(other)?,
    })
    .map_err(other)?;

    let token = new_token();
    home.write_token(&token).map_err(other)?;
    let listener = TcpListener::bind(config.listen).await.map_err(other)?;
    let address = listener.local_addr().map_err(other)?;
    // Resume once ace's tools are back, so a paused turn about to use one finds it; never wait
    // long, since Spade works without ace.
    {
        let (engine, ace) = (engine.clone(), ace.clone());
        tokio::spawn(async move {
            if let Some(link) = ace
                && link.holds_grant(Duration::from_secs(3)).await
            {
                link.ready_within(Duration::from_secs(10)).await;
            }
            engine.open_for_work();
        });
    }
    home.write_server_json(address, std::process::id())
        .map_err(other)?;
    tracing::info!(%address, "spade listening");

    let state = AppState {
        engine: engine.clone(),
        token: token.into(),
        keys: keychain,
        ace,
    };
    let stopping = async move {
        shutdown_signal().await;
        tracing::info!("stopping: pausing open turns");
        engine
            .pause_for_stop(spade_core::maintenance::STOP_STEP_ALLOWANCE)
            .await;
    };
    let served = spade_server::serve(listener, state, stopping).await;
    home.clear_server_json();
    served.map_err(other)?;
    tracing::info!("spade stopped");
    Ok(())
}

/// Resolves on Ctrl-C, or on SIGTERM from the service manager or an updater.
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
