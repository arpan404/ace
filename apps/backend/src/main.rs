use ace_fs::AppDirs;
use ace_server::{ServerConfig, parse_bind_addr};
use clap::Parser;
use tracing::{error, info};

#[derive(Debug, Parser)]
#[command(
    name = "ace-backend",
    about = "Ace local runtime and WebSocket backend"
)]
struct Args {
    #[arg(long, env = "ACE_LAN")]
    lan: bool,

    #[arg(long, env = "ACE_PORT", default_value_t = 3773)]
    port: u16,
}

#[tokio::main]
async fn main() {
    let _logger = ace_logger::init_logger().expect("failed to initialize ace logger");

    let args = Args::parse();
    let paths = AppDirs::resolve().expect("failed to resolve ace app paths");
    let host = if args.lan { "0.0.0.0" } else { "127.0.0.1" };
    let server = ServerConfig::new(host.to_owned(), args.port);
    let bind_addr = parse_bind_addr(&server).expect("parse backend bind address");
    let listener = match tokio::net::TcpListener::bind(bind_addr).await {
        Ok(listener) => listener,
        Err(error) => {
            error!(%error, bind = %server.bind_addr(), "failed to bind ace backend");
            std::process::exit(1);
        }
    };

    info!(
        state_dir = %paths.state_dir.display(),
        bind = %server.bind_addr(),
        "ace backend listening"
    );

    if let Err(error) = axum::serve(listener, ace_server::router()).await {
        error!(%error, "ace backend stopped");
        std::process::exit(1);
    }
}
