use ace_platform::AppPaths;
use ace_server::{ServerConfig, parse_bind_addr};
use ace_ui::{DesktopBackend, ShellViewModel, app_shell};
use clap::Parser;
use gpui::{App, Application, Bounds, WindowBounds, WindowOptions, px, size};
use tracing::{error, info};

#[derive(Debug, Parser)]
#[command(name = "ace-desktop", about = "Native ace desktop host")]
struct Args {
    #[arg(long, env = "ACE_LAN")]
    lan: bool,

    #[arg(long, env = "ACE_PORT", default_value_t = 3773)]
    port: u16,
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let args = Args::parse();
    let paths = AppPaths::resolve().expect("failed to resolve ace app paths");
    let bind_addr = if args.lan {
        "0.0.0.0".to_owned()
    } else {
        "127.0.0.1".to_owned()
    };
    let server = ServerConfig::new(bind_addr, args.port);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .thread_name("ace-desktop-runtime")
        .build()
        .expect("create desktop runtime");
    let bind_addr = parse_bind_addr(&server).expect("parse desktop server bind address");
    runtime.spawn(async move {
        let listener = match tokio::net::TcpListener::bind(bind_addr).await {
            Ok(listener) => listener,
            Err(error) => {
                error!(%error, "failed to bind ace desktop server");
                return;
            }
        };
        if let Err(error) = axum::serve(listener, ace_server::router()).await {
            error!(%error, "ace desktop server stopped");
        }
    });

    info!(state_dir = %paths.state_dir.display(), bind = %server.bind_addr(), "starting ace desktop shell");
    let backend = DesktopBackend::new(
        runtime.handle().clone(),
        format!("ws://{}/api/ws", server.bind_addr()),
    );
    let model = ShellViewModel {
        title: "Ace".to_owned(),
        workspace_name: "t3code".to_owned(),
        branch_name: "rust-port".to_owned(),
        status: format!("WS {}", server.bind_addr()),
    };

    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1280.0), px(820.0)), cx);
        let backend = backend.clone();
        let model = model.clone();
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: None,
                ..WindowOptions::default()
            },
            move |_window, cx| app_shell(model.clone(), backend.clone(), cx),
        )
        .expect("failed to open ace desktop window");
    });
}
