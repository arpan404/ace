// SPDX-License-Identifier: Apache-2.0

//! `ace-files`: the daemon's file system process (ADR 0178, docs/files/plan.md).
//!
//! It speaks `files-wire` on stdio, holds one lister, path index and watcher per open checkout,
//! and keeps every blocking filesystem call off the threads that read requests and write
//! responses. Two runtime workers serve the requests; the filesystem work runs on blocking
//! threads, and search and index builds bring their own parallel walkers.

mod convert;
mod dispatch;
mod error;
mod guard;
mod io;
mod ops;
mod quick_open;
mod requests;
mod roots;
mod subscriptions;
mod writer;

use std::process::ExitCode;

fn main() -> ExitCode {
    let version = env!("CARGO_PKG_VERSION");
    match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            runtime.block_on(dispatch::run(version));
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("ace-files: cannot start the runtime: {error}");
            ExitCode::FAILURE
        }
    }
}
