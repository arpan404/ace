// SPDX-License-Identifier: Apache-2.0
//! The daemon's start and stop order, composed from the modules beside this one.
//!
//! This is `index.ts`'s `startDaemon` and `process-daemon.ts` reduced to slice 1:
//! the home, the lock, the log, the run marker, the store's open, the token and
//! host id, the listeners and the endpoint file, then signals or a stop request,
//! then the orderly shutdown that records how the run ended.
//!
//! TypeScript cases ported: `apps/daemon/src/lifecycle.process.test.ts`
//! ("a daemon starts, listens, and stops in order", "a second start on the same
//! home exits lock-held"), `apps/daemon/src/cli-stop.process.test.ts`
//! ("`ace stop` prints the receipt and the process is gone"), and
//! `apps/daemon/src/cli-start.process.test.ts` ("`ace start --json` prints the
//! five keys", "a newer data format is refused with exit 65", "a taken port is
//! address-in-use").

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;

mod signals;
mod wiring;

use self::signals::{Signals, StopReason, wait_for_stop};
use self::wiring::{address_in_use, fields_value, print_started, remote_identity};

use crate::config::{Config, Listen};
use crate::exit_codes::ExitCode;
use crate::home;
use crate::http::HttpConfig;
use crate::lock::{Lock, LockError};
use crate::log::Log;
use crate::receipt::{Admission, State};
use crate::run_marker::Run;
use crate::store::Store;
use crate::token;
use crate::transport::Transport;

/// `shutdownDeadline("Daemon", ..., 7_000)`: how long the orderly stop may take.
const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(7);

/// What `main` prints once the daemon listens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Output {
    /// `ace start` and `ace serve`: the lines a person reads.
    Text,
    /// `ace serve --json`: the object the launcher and the desktop app read.
    Json,
}

/// A start that could not complete: the exit code and the sentence to print.
#[derive(Debug)]
pub struct FailedStart {
    pub code: ExitCode,
    pub message: String,
}

impl FailedStart {
    fn failed(message: impl Into<String>) -> Self {
        Self {
            code: ExitCode::Failed,
            message: message.into(),
        }
    }
}

/// `startDaemon` + `runDaemonProcess`: run until a signal or a stop request, then
/// shut down in order and return the process's exit code.
pub async fn run(config: Config, output: Output) -> Result<ExitCode, FailedStart> {
    // The process's lifetime is installed before anything can advertise the
    // endpoint, as `runDaemonProcess` installs it before startup: a signal that
    // arrives right after `ace start` prints its line still stops the daemon.
    let signals = Signals::install();
    let data_dir = config.data_dir.clone();
    // The home's format is settled before anything opens or writes in it.
    match home::prepare(&data_dir, home::HOME_FORMAT_VERSION, home::now_ms()) {
        Ok(_) => {}
        Err(error) => {
            if let home::HomeError::NewerData {
                home,
                stored,
                supported,
                message,
            } = &error
            {
                let log = Log::open(&data_dir, config.log_level);
                log.log(
                    "error",
                    message,
                    serde_json::json!({
                        "home": home.display().to_string(),
                        "storedFormat": stored,
                        "supportedFormat": supported,
                        "dataFormat": home::format_name(home::HOME_FORMAT_VERSION),
                    }),
                );
            }
            return Err(FailedStart {
                code: if error.is_newer_data() {
                    ExitCode::NewerData
                } else {
                    ExitCode::Failed
                },
                message: error.to_string(),
            });
        }
    }
    let lock = Lock::acquire(&data_dir).map_err(|error| match error {
        LockError::Held(held) => FailedStart {
            code: ExitCode::LockHeld,
            message: held.to_string(),
        },
        LockError::Failed(message) => FailedStart::failed(message),
    })?;
    // Under the lock, again: a newer build may have set this home aside in between.
    if let Err(error) = home::prepare(&data_dir, home::HOME_FORMAT_VERSION, home::now_ms()) {
        return Err(FailedStart {
            code: if error.is_newer_data() {
                ExitCode::NewerData
            } else {
                ExitCode::Failed
            },
            message: error.to_string(),
        });
    }
    let log = Arc::new(Log::open(&data_dir, config.log_level));
    log.log(
        "info",
        "Daemon modules loaded",
        serde_json::json!({
            "version": config.version,
            "aceClient": config.ace_client,
        }),
    );
    if config.safe_mode {
        log.log(
            "warn",
            "Daemon starting in safe mode",
            serde_json::json!({}),
        );
    }
    if config.maintenance {
        log.log(
            "info",
            "Daemon starting in maintenance",
            serde_json::json!({"maintenance": true}),
        );
    }
    let owner = crate::ids::uuid_v4().ok();
    let run = match Run::begin(
        &data_dir,
        i64::from(std::process::id()),
        home::now_ms() as f64,
        owner.as_deref(),
    ) {
        Ok(run) => {
            let (level, message, fields) = run.previous_line();
            log.log(level, message, fields_value(fields));
            Some(run)
        }
        Err(error) => {
            log.log(
                "warn",
                "Daemon run marker could not be written",
                serde_json::json!({"error": error.to_string()}),
            );
            None
        }
    };
    let began = std::time::Instant::now();
    let store = match Store::open_while_busy(&data_dir, |attempt, delay, error| {
        log.log(
            "warn",
            "The event store is busy; opening it again shortly",
            serde_json::json!({"attempt": attempt, "delayMs": delay, "error": error.to_string()}),
        );
    })
    .await
    {
        Ok(store) => store,
        Err(error) => {
            log.log(
                "error",
                "Daemon startup failed",
                serde_json::json!({"error": error.to_string()}),
            );
            return Err(FailedStart::failed(error.to_string()));
        }
    };
    log.log(
        "info",
        "Event store opened",
        serde_json::json!({"durationMs": began.elapsed().as_millis()}),
    );
    let tokens = token::load(&data_dir).map_err(|error| FailedStart::failed(error.to_string()))?;
    let _host_id =
        token::load_host_id(&data_dir).map_err(|error| FailedStart::failed(error.to_string()))?;
    let (stop, mut stopped) = mpsc::unbounded_channel::<StopReason>();
    let home_for_stop = data_dir.clone();
    let stop_for_http = stop.clone();
    let accepted: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let accepted_for_http = Arc::clone(&accepted);
    let http = HttpConfig {
        token: tokens.token.clone(),
        version: config.version.clone(),
        allowed_origins: config.web_origins.clone(),
        on_stop: Arc::new(move |admission: Admission| {
            // The receipt is written before the answer leaves, so `ace stop`
            // never reads a stale one.
            let _ = crate::receipt::write(
                &home_for_stop,
                &admission.receipt_id,
                State::Pending,
                home::now_ms() as f64,
                None,
                false,
            );
            *accepted_for_http
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Some(admission.receipt_id);
            let _ = stop_for_http.send(StopReason {
                source: "stop-request",
                signal: None,
            });
        }),
    };
    let identity = remote_identity(&data_dir, config.listen, config.remote_port);
    if config.listen != Listen::Local && identity.is_none() {
        log.log(
            "warn",
            "Remote access is configured without a TLS identity",
            serde_json::json!({"listen": match config.listen {
                Listen::Local => "local",
                Listen::Lan => "lan",
                Listen::Tailscale => "tailscale",
            }}),
        );
    }
    let transport =
        match Transport::bind(http, config.port, config.listen, identity, Arc::clone(&log)).await {
            Ok(transport) => transport,
            Err(error) => {
                log.log(
                    "error",
                    "Daemon startup failed",
                    serde_json::json!({"error": error.to_string()}),
                );
                return Err(FailedStart {
                    code: if address_in_use(&error) {
                        ExitCode::AddressInUse
                    } else {
                        ExitCode::Failed
                    },
                    message: error.to_string(),
                });
            }
        };
    let endpoint = crate::endpoint::write(&data_dir, &transport.http_url())
        .map_err(|error| FailedStart::failed(error.to_string()))?;
    log.log(
        "info",
        "Daemon listening",
        serde_json::json!({"url": transport.url(), "sinceSpawnMs": began.elapsed().as_millis()}),
    );
    print_started(&transport, &tokens.path, output);
    let reason = wait_for_stop(&mut stopped, signals).await;
    log.log(
        "info",
        "Daemon stopping",
        serde_json::json!({"source": reason.source, "signal": reason.signal}),
    );
    // The shutdown is bounded; what it could not finish is named in its receipt.
    let closing = async {
        transport.close(Duration::from_secs(1)).await;
        store.close();
    };
    let overran = tokio::time::timeout(SHUTDOWN_DEADLINE, closing)
        .await
        .is_err();
    let admission = accepted
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .take();
    if let Some(admission) = admission {
        let _ = crate::receipt::write(
            &data_dir,
            &admission,
            if overran {
                State::Failed
            } else {
                State::Succeeded
            },
            home::now_ms() as f64,
            overran.then_some("Daemon cleanup failed or exceeded its deadline"),
            false,
        );
    }
    if let Some(run) = &run {
        let overran = if overran {
            vec!["listeners".to_owned()]
        } else {
            Vec::new()
        };
        run.stopped(reason.source, reason.signal, &overran);
    }
    crate::endpoint::retire(Some(&endpoint));
    lock.release();
    Ok(if overran {
        ExitCode::Failed
    } else {
        ExitCode::Ok
    })
}
