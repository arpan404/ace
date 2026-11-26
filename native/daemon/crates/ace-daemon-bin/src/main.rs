// SPDX-License-Identifier: Apache-2.0
//! `ace-daemon`: ace's daemon as a Rust program (ADR 0226, slice 1).
//!
//! It reads the same environment `apps/daemon/src/index.ts` reads, opens the same
//! home and files, serves the wire's front door on the same listeners, and exits
//! with the same codes `@ace/service/exit-codes` names. The program composes the
//! modules beside it; no behaviour lives here.

mod config;
mod daemon;
mod endpoint;
mod exit_codes;
mod home;
mod http;
mod ids;
mod lock;
mod log;
mod receipt;
mod run_marker;
mod session;
mod store;
#[cfg(test)]
mod test_support;
mod token;
mod transport;

use std::path::PathBuf;

use exit_codes::ExitCode;

/// The words this program accepts: `start` (the default), `serve`, and `--json`.
fn output(words: &[String]) -> Result<daemon::Output, String> {
    let mut json = false;
    let mut commands = 0;
    for word in words {
        match word.as_str() {
            "--json" => json = true,
            "start" | "serve" => commands += 1,
            other => {
                return Err(format!(
                    "unknown argument {other}. Run `ace-daemon [start|serve] [--json]`"
                ));
            }
        }
    }
    if commands > 1 {
        return Err("expected one of start or serve".to_owned());
    }
    Ok(if json {
        daemon::Output::Json
    } else {
        daemon::Output::Text
    })
}

fn main() {
    let words: Vec<String> = std::env::args().skip(1).collect();
    let output = match output(&words) {
        Ok(output) => output,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(ExitCode::Usage.number());
        }
    };
    let environment = config::Env::from_process();
    let user_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let config = match config::read(&environment, &user_home) {
        Ok(config) => config,
        Err(error) => {
            // A bad environment is a usage refusal, as the CLI reports a Zod
            // refusal (`cli/contract.test.ts`: a Zod error is usage/bad_argument).
            eprintln!("{error}");
            std::process::exit(ExitCode::Usage.number());
        }
    };
    // ADR 0223 §4: tokio with two workers for the listener's I/O.
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("ace-daemon")
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cannot start the daemon's runtime: {error}");
            std::process::exit(ExitCode::Failed.number());
        }
    };
    let outcome = runtime.block_on(daemon::run(config, output));
    // Drop the runtime before exiting, so its tasks stop with the listeners.
    drop(runtime);
    match outcome {
        Ok(code) => std::process::exit(code.number()),
        Err(failed) => {
            eprintln!("{}", failed.message);
            std::process::exit(failed.code.number());
        }
    }
}
