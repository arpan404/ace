// SPDX-License-Identifier: Apache-2.0
//! Read-only smoke test: probes the local daemon and prints `GET /v1/status` verbatim.

use std::process::ExitCode;

use cli_wire::{DEFAULT_HTTP_TIMEOUT, Home, HttpMethod, TcpProbe, http_request_local, reach_local};

fn main() -> ExitCode {
    match run() {
        Ok(raw) => {
            println!("{raw}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("error ({}): {err}", err.cli_code());
            ExitCode::from(err.exit_code())
        }
    }
}

fn run() -> Result<String, cli_wire::WireError> {
    let home = Home::from_env()?;
    let local = reach_local(&home, &TcpProbe)?;
    let response = http_request_local(
        &local,
        HttpMethod::Get,
        "/v1/status",
        None,
        DEFAULT_HTTP_TIMEOUT,
    )?;
    Ok(response.as_str().to_owned())
}
