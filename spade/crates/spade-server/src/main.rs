use std::sync::Arc;
use std::time::Duration;

use spade_fetch::{Fetcher, Policy};
use spade_keys::{KeyStore, Keys};
use spade_models::Models;
use spade_search::{Search, SearchConfig};
use spade_server::api::AppState;
use spade_server::clock::{SystemClock, SystemIds, local_offset_seconds};
use spade_server::computer::{Computers, Terminals};
use spade_server::config::Config;
use spade_server::engine::{Engine, Limits, Setup};
use spade_server::home::{DEFAULT_SEARCH, Home, HomeError, new_token};
use spade_server::images::ImageStore;
use spade_server::learning::{Learning, SkillFeedback, SkillPropose};
use spade_server::presets;
use spade_server::research::{LiveWeb, ResearchTool};
use spade_server::skill_store::SkillStore;
use spade_server::tools::{
    AceLink, AceTarget, ConnectorSource, DecisionLog, EngineHandle, Retry, SkillLibrary, SkillLoad,
    SkillSearch, TaskGoal, TaskPlan, TaskStatus, Todo, Tool, ToolSource, Toolbox, WebFetch,
    WebSearch,
};
use spade_server::workspace::shell::Shell;
use spade_server::workspace::{Workspaces, workspace_tools};
use spade_store::Store;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Every allocation is counted, so a document reader child can be held to a memory cap on every
/// platform (ADR 0134). The server itself runs without a cap.
#[global_allocator]
static ALLOCATOR: cap::Cap<std::alloc::System> = cap::Cap::new(std::alloc::System, usize::MAX);

/// Exit code when another Spade holds the data folder (docs/ace-integration.md).
const BUSY: u8 = 3;

/// Plain and synchronous, so the document reader (and the other one-shot modes) run before any
/// async runtime or its threads exist; the server builds its runtime only after them.
fn main() -> std::process::ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|flag| flag == "--version") {
        println!("{}", spade_server::home::VERSION);
        return std::process::ExitCode::SUCCESS;
    }
    // The document reader (ADR 0134): one file on stdin, its text on stdout, then exit. Runs
    // before logging starts, so nothing else ever writes to stdout.
    if let Some(flag) = args.first()
        && flag == spade_docs::CHILD_ARG
    {
        let name = args.get(1).and_then(|n| n.to_str()).unwrap_or("file");
        let memory = spade_docs::child_memory(args.get(2).and_then(|n| n.to_str()));
        // Past the cap an allocation fails and the child aborts; the server reports the file
        // as unreadable.
        let _ = ALLOCATOR.set_limit(ALLOCATOR.allocated().saturating_add(memory));
        spade_docs::limit_memory(memory);
        let code = spade_docs::serve_child(
            name,
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
        );
        return std::process::ExitCode::from(u8::try_from(code).unwrap_or(1));
    }
    // Linux's sandbox launcher (ADR 0167): applies a Landlock plan to itself, then runs the
    // command in its place.
    if let Some(flag) = args.first()
        && flag == spade_sandbox::linux::LAUNCHER_ARG
    {
        return sandbox_exec(&args[1..]);
    }
    if let Some(flag) = args.first()
        && flag == "--check-migrations"
    {
        return check_migrations(args.get(1));
    }
    match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime.block_on(serve_main()),
        Err(error) => {
            eprintln!("spade could not start its runtime: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

/// The server: logging, then `run` on the runtime `main` built.
async fn serve_main() -> std::process::ExitCode {
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

/// `spade --check-migrations <path>`: an updater asks whether this build can open a
/// snapshot of Spade's database (docs/ace-integration.md, "Updates"). Migrates and checks that
/// file only; never touches the data folder. Exit 0 if usable, else 1 with one line saying why.
fn check_migrations(path: Option<&std::ffi::OsString>) -> std::process::ExitCode {
    let Some(path) = path else {
        eprintln!("usage: spade --check-migrations <path to a copy of spade.sqlite>");
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

    // Presets are the catalogue built in, so an upgrade sees new shipped facts at once
    // (SPADE_MODEL_CATALOG swaps in another file for development). A copy an earlier Spade left in
    // the data folder is adopted once if it was edited, then moved aside.
    let override_path = env("SPADE_MODEL_CATALOG").filter(|v| !v.trim().is_empty());
    let startup = presets::load(
        &home.dir,
        override_path.as_deref().map(std::path::Path::new),
    )
    .map_err(other)?;
    let models = Models::new(startup.presets, keys, spade_server::home::VERSION).map_err(other)?;
    let search_path = home
        .file_or_default("search.json", DEFAULT_SEARCH)
        .map_err(other)?;
    // Search keys have their own keychain accounts (`search:<id>`), apart from endpoints'.
    let search_lookup = keychain.clone();
    let search_keys = Keys::keychain_then_env(
        move |backend| {
            search_lookup
                .as_ref()
                .and_then(|k| k.search_key(backend).ok().flatten())
        },
        |var| std::env::var(var).ok(),
    );
    let search = Search::new(
        SearchConfig::load(&search_path).map_err(other)?,
        search_keys,
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
    // Documents are read by this same binary in a child process it kills at the deadline
    // (ADR 0134); without a path to it, in process.
    let reader = match std::env::current_exe() {
        Ok(program) => spade_docs::Extractor::child(program, Vec::new()),
        Err(error) => {
            tracing::warn!(%error, "reading documents in process: this binary's path is unknown");
            spade_docs::Extractor::in_process()
        }
    };
    let fetcher = Arc::new(
        Fetcher::new(Policy::default(), Duration::from_secs(30)).with_documents(reader.clone()),
    );
    let search = Arc::new(search);
    // Tools that find the calling bot through the engine, set once it exists (ADR 0130).
    // What a bot's command leaves behind is reparented to Spade, so it can be ended (Linux).
    #[cfg(unix)]
    spade_server::workspace::adopt_orphans();
    let bots = EngineHandle::default();
    if let Some(link) = &ace {
        link.act_for(bots.clone());
    }
    let mut core: Vec<Arc<dyn Tool>> = vec![
        Arc::new(WebSearch {
            search: search.clone(),
            ace_fallback: ace.is_some(),
            bots: bots.clone(),
        }),
        Arc::new(WebFetch(fetcher.clone())),
        Arc::new(Todo),
        Arc::new(TaskStatus),
        Arc::new(TaskGoal),
        Arc::new(TaskPlan),
        Arc::new(DecisionLog),
    ];
    let workspaces = Workspaces::new(home.dir.join("workspace"));
    // Each bot's commands, services and plugin servers run in its OS sandbox, with their traffic
    // through Spade's egress proxy (ADR 0167). `SPADE_SANDBOX=off` turns it off for development:
    // commands then run as before and stay reviewed.
    let runner = if env("SPADE_SANDBOX").is_some_and(|v| v.trim() == "off") {
        spade_sandbox::Runner::unavailable("The sandbox is turned off (SPADE_SANDBOX=off).")
    } else {
        let launcher = std::env::current_exe().ok();
        tokio::task::spawn_blocking(move || spade_sandbox::Runner::probe(launcher))
            .await
            .unwrap_or_else(|_| spade_sandbox::Runner::unavailable("The sandbox probe failed."))
    };
    tracing::info!(status = ?runner.status(), "sandbox");
    let person_home = env(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let security = spade_server::security::Security::start(spade_server::security::Setup {
        runner,
        store: Store::open(&home.database()).map_err(other)?,
        home: person_home,
        spade_data: home.dir.clone(),
        ace_data: env("SPADE_ACE_HOME").map(std::path::PathBuf::from),
        workspaces: home.dir.join("workspace"),
        log_dir: home.dir.join("egress"),
        clock: Arc::new(SystemClock),
        ids: Arc::new(SystemIds),
        bots: bots.clone(),
    })
    .await;
    let shell = Shell::system().confined(security.clone());
    // Deep research (ADR 0135), reading through the same backends and fetcher.
    core.push(Arc::new(ResearchTool::new(
        Arc::new(LiveWeb {
            search: search.clone(),
            fetcher,
        }),
        workspaces.clone(),
        bots.clone(),
    )));
    // Each bot's computer (ADR 0142): its terminal is where its shell commands run.
    let terminals = Terminals::new(
        home.dir.join("terminal"),
        workspaces.clone(),
        shell.clone(),
        Arc::new(SystemClock),
    );
    let computers = Computers::open(
        home.dir.join("computer"),
        workspaces.clone(),
        terminals.clone(),
        Arc::new(SystemClock),
    );
    core.extend(workspace_tools(
        workspaces.clone(),
        bots.clone(),
        spade_server::computer::shell_commands(&terminals, shell.clone()),
    ));
    // Bots' owned services (ADR 0160), through the same shell rules as `shell`.
    let services =
        spade_server::services::Services::new(workspaces.clone(), shell.clone(), bots.clone());
    core.extend(spade_server::tools::service_tools(&services));
    // Pushes, comments and messages with the person's sign-ins, outside the sandbox (ADR 0171).
    core.extend(spade_server::tools::outward::outward_tools(
        workspaces.clone(),
        bots.clone(),
        Arc::new(spade_server::tools::outward::SystemHost),
        Arc::new(spade_server::tools::outward::SandboxStage::new(
            shell.clone(),
        )),
        home.dir.join("outward"),
    ));
    core.extend(spade_server::media::tools::all(
        workspaces.clone(),
        bots.clone(),
    ));
    // Spade's own skill store (ADR 0151): ace's library mirrored with its files while ace is
    // there, skills written in Spade otherwise. Spade Cloud has the store with no ace.
    let upstream = ace
        .clone()
        .map(|link| link as Arc<dyn spade_server::skill_store::Upstream>);
    let skill_store = SkillStore::open(
        home.dir.join("skills"),
        Store::open(&home.database()).map_err(other)?,
        Arc::new(SystemClock),
        upstream,
    );
    tokio::spawn(skill_store.clone().run_mirror());
    // Skills installed from ace's marketplace (ADR 0168), copied the same way.
    tokio::spawn(skill_store.clone().run_market());
    let library: Arc<dyn SkillLibrary> = skill_store.clone();
    let learned = Arc::new(Learning::new(
        home.dir.join("skills"),
        Arc::new(SystemClock),
        library.clone(),
    ));
    core.push(Arc::new(
        SkillSearch::new(library.clone()).with_uses(bots.clone()),
    ));
    core.push(Arc::new(
        SkillLoad::new(library.clone())
            .with_notes(learned.clone(), bots.clone())
            .with_workspaces(workspaces.clone(), bots.clone()),
    ));
    core.push(Arc::new(SkillPropose {
        learning: learned.clone(),
        bots: bots.clone(),
    }));
    core.push(Arc::new(SkillFeedback {
        learning: learned.clone(),
        bots: bots.clone(),
    }));
    let skills: Option<Arc<dyn SkillLibrary>> = Some(library);
    let learning: Option<Arc<Learning>> = Some(learned);
    let mut tools = Toolbox::new(core).with_source(spade_server::media::tools::images(&bots));
    if let Some(link) = &ace {
        tools = tools.with_source(link.clone() as Arc<dyn ToolSource>);
    }
    // The person's apps (ADR 0131). Sessions open once Spade listens, so the sign-in callback
    // has an address and nothing reaches the network or keychain before bind.
    let connectors = spade_connect::Connectors::open(spade_connect::Setup {
        store: Store::open(&home.database()).map_err(other)?,
        keys: keychain.clone(),
        clock: spade_connect::system_clock(),
        random: Arc::new(spade_connect::OsRandom),
        catalogue: spade_connect::catalogue::shipped(),
        timeout: Duration::from_secs(60),
        relist: spade_connect::RELIST,
        addresses: spade_connect::Addresses::system(),
        // Spade's client ID metadata document on acehq.dev (ADR 0136); another for development.
        client_metadata: Some(
            env("SPADE_CLIENT_METADATA_URL")
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| spade_connect::CLIENT_METADATA_URL.to_owned()),
        ),
        // Spade's own registered apps: public client IDs, never a secret (ADR 0137).
        apps: spade_connect::apps::shipped(),
        tick: Duration::from_secs(1),
        // Spade Cloud signs in to apps that need a client secret, with the person's ace account
        // (ADR 0140). `SPADE_CLOUD_URL=off` leaves those apps on the person's own client ID.
        cloud: match env("SPADE_CLOUD_URL").map(|v| v.trim().to_owned()) {
            Some(off) if off == "off" => None,
            url => Some(spade_connect::Cloud {
                url: url
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| spade_connect::CLOUD_URL.to_owned()),
                credential: Arc::new(spade_server::tools::CloudAccount::new(ace.clone())),
            }),
        },
    })
    .map_err(other)?;
    tools = tools.with_source(Arc::new(ConnectorSource::new(
        connectors.clone(),
        Store::open(&home.database()).map_err(other)?,
    )));
    // The person's plugins (ADR 0151), read from ace: rules, hooks and local MCP servers.
    let plugins = match &ace {
        Some(link) => {
            let plugins = spade_server::plugins::Plugins::new(
                link.clone(),
                Store::open(&home.database()).map_err(other)?,
                workspaces.clone(),
                shell.clone(),
            );
            tools = tools.with_source(Arc::new(spade_server::tools::PluginTools::new(
                plugins.clone(),
                Store::open(&home.database()).map_err(other)?,
            )));
            // Their skills and commands are store skills, offered to the bots allowed them.
            plugins.set_skill_store(skill_store.clone());
            Some(plugins)
        }
        None => None,
    };

    let engine = Engine::open(Setup {
        store: Store::open(&home.database()).map_err(other)?,
        models,
        tools,
        clock: Arc::new(SystemClock),
        ids: Arc::new(SystemIds),
        utc_offset_seconds: local_offset_seconds(),
        limits: limits(&config),
        skills,
        images: ImageStore::open(&home.images()).map_err(other)?,
        adopt: startup.adopt,
        keychain: keychain.clone(),
    })
    .map_err(other)?;
    bots.set(&engine);
    engine.set_security(security.clone());
    // Workers get connectors only from their makers' (ADR 0161).
    engine.set_connector_grants(connectors.clone());
    if let Some(plugins) = &plugins {
        engine.set_plugins(plugins.clone());
        // Plugin agents are helper profiles of the bots allowed their plugins.
        engine.set_profile_source(plugins.clone());
    }
    // Before work opens: a bot the person had when Spade stopped stays paused.
    engine.set_computers(computers.clone());
    engine.set_services(services.clone());
    if let Some(link) = &ace {
        let agents = engine
            .agents()
            .map(|views| views.into_iter().map(|v| v.agent.id).collect())
            .unwrap_or_default();
        computers.set_daemon(link.clone(), agents, spade_server::computer::RESYNC);
    }
    computers.reap_idle(spade_server::computer::terminal::IDLE);
    // The person's own SearXNG, as they set it in Spade's settings.
    match engine.searxng_url() {
        Ok(url) => {
            if let Err(error) = search.set_searxng(url.as_deref()) {
                tracing::warn!(%error, "the saved SearXNG address is not used");
            }
        }
        Err(error) => tracing::warn!(%error, "could not read the SearXNG address"),
    }
    engine.media().read_with(reader);
    if let Some(link) = &ace {
        engine.set_remote(link.clone());
    }
    let token = new_token();
    home.write_token(&token).map_err(other)?;
    let listener = TcpListener::bind(config.listen).await.map_err(other)?;
    let address = listener.local_addr().map_err(other)?;
    connectors.set_listening(address);
    connectors.start();
    // Bots on the person's subscriptions run their turns through ace (ADR 0133). Set before
    // work opens, so a turn resumed at start finds ace.
    if let Some(link) = ace.clone() {
        engine.set_brains(Arc::new(move || link.brains()));
    }
    spade_server::startup::finish(
        engine.clone(),
        ace.clone(),
        startup.set_aside,
        spade_server::startup::SETTLE_DEADLINE,
    );
    // Routines (ADR 0129): new ones default to the machine's zone; slots and ace's thread
    // events wake bots from here on.
    if let Some(zone) = jiff::tz::TimeZone::system().iana_name() {
        spade_server::routines::set_default_zone(&engine, zone);
    }
    spade_server::routines::start(&engine);
    if let Some(link) = ace.clone() {
        spade_server::routines::watch_ace(&engine, move || link.daemon_socket());
    }
    home.write_server_json(address, std::process::id())
        .map_err(other)?;
    tracing::info!(%address, "spade listening");

    let state = AppState {
        engine: engine.clone(),
        token: token.into(),
        keys: keychain,
        ace,
        workspaces: Some(workspaces),
        learning,
        skill_store: Some(skill_store),
        connectors: Some(connectors),
        search: Some(search),
    };
    let stopping = async move {
        shutdown_signal().await;
        tracing::info!("stopping: pausing open turns");
        engine
            .pause_for_stop(spade_core::maintenance::STOP_STEP_ALLOWANCE)
            .await;
        terminals.end_all();
        // A `keep` service starts again with Spade; the others are reported lost then.
        services.stop_everything();
        if let Some(plugins) = &plugins {
            plugins.stop_all();
        }
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

/// The engine's limits, with what the environment set.
fn limits(config: &Config) -> Limits {
    let defaults = Limits::default();
    Limits {
        max_parallel_tools: config.parallel_tools.unwrap_or(defaults.max_parallel_tools),
        helpers_at_once: config.helpers_at_once.unwrap_or(defaults.helpers_at_once),
        workers_at_once: config.workers_at_once.unwrap_or(defaults.workers_at_once),
        context_budget: config.context_tokens.unwrap_or(defaults.context_budget),
        knowledge_bytes: config.knowledge_bytes.unwrap_or(defaults.knowledge_bytes),
        ..defaults
    }
}

/// `spade sandbox-exec <plan> <program> <args>…`: answers only when the command can't start.
fn sandbox_exec(args: &[std::ffi::OsString]) -> std::process::ExitCode {
    let refused = |why: &str| {
        eprintln!("spade sandbox-exec: {why}");
        std::process::ExitCode::from(126)
    };
    let (Some(plan), Some(program)) = (args.first(), args.get(1)) else {
        return refused("a plan and a program are needed");
    };
    #[cfg(all(target_os = "linux", feature = "landlock"))]
    {
        let Some(plan) = plan
            .to_str()
            .and_then(|text| serde_json::from_str::<spade_sandbox::linux::Plan>(text).ok())
        else {
            return refused("the plan doesn't parse");
        };
        refused(&spade_sandbox::linux::exec(&plan, program, &args[2..]))
    }
    #[cfg(not(all(target_os = "linux", feature = "landlock")))]
    {
        let _ = (plan, program);
        refused("this build has no Linux sandbox")
    }
}
