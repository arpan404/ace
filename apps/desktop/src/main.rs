use ace_platform::AppPaths;
use ace_server::ServerConfig;
use ace_ui::app_shell;
use clap::Parser;
use gpui::{App, Application, Bounds, WindowBounds, WindowOptions, px, size};
use tracing::info;

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

    info!(state_dir = %paths.state_dir.display(), bind = %server.bind_addr(), "starting ace desktop shell");

    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1280.0), px(820.0)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: None,
                ..WindowOptions::default()
            },
            |_window, cx| app_shell(cx),
        )
        .expect("failed to open ace desktop window");
    });
}
