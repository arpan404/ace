use ace_error::AceResult;
use ace_fs::AppPaths;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

pub fn init_logger() -> AceResult<WorkerGuard> {
    let appender = tracing_appender::rolling::never(AppPaths::Logs.path()?, "ace.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(false))
        .with(
            fmt::layer()
                .with_target(false)
                .with_ansi(false)
                .with_writer(writer),
        )
        .try_init()
        .ok();

    Ok(guard)
}
