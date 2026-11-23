// SPDX-License-Identifier: Apache-2.0
//! The providers commands: providers and accounts, models, the ace account, machines,
//! devices, remote profiles and outside MCP clients (ADR 0178 §7).
//!
//! Interactive sign-in and pairing flows stay handed over: `provider login` drives the
//! provider's own sign-in through polls, browser addresses and choices; `provider account`
//! runs the `@ace/accounts` registry; `account login` polls a browser sign-in; `account
//! machine-code set` asks without echo; `device pair` prints a QR code; `remote add` redeems
//! a pairing link over pinned TLS; and `mcp request` watches pushed daemon states. None of
//! those can match the TypeScript byte for byte yet, so the bundle still runs them.

use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome};

mod account;
mod devices;
mod machines;
mod mcp;
mod models;
mod provider;
mod remote;
pub mod render;
mod session;
mod store;

/// The commands this module answers itself. Every id is in the table, which `check:cli` proves.
pub const IDS: &[&str] = &[
    "provider.list",
    "provider.show",
    "provider.capabilities",
    "model.list",
    "account.status",
    "account.logout",
    "account.machine-code.clear",
    "machine.list",
    "device.list",
    "device.revoke",
    "remote.list",
    "remote.use",
    "remote.remove",
    "mcp.list",
    "mcp.add",
    "mcp.revoke",
];

/// Runs one ported providers command.
pub fn dispatch<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    match parsed.command.id {
        "provider.list" => provider::provider_list(parsed, out, err),
        "provider.show" => provider::provider_show(parsed, out, err),
        "provider.capabilities" => models::capabilities(parsed, out, err),
        "model.list" => models::model_list(parsed, out, err),
        "account.status" => account::status(parsed, out, err),
        "account.logout" => account::logout(parsed, out, err),
        "account.machine-code.clear" => account::machine_code_clear(parsed, out, err),
        "machine.list" => machines::list(parsed, out, err),
        "device.list" => devices::list(parsed, out, err),
        "device.revoke" => devices::revoke(parsed, out, err),
        "remote.list" => remote::list(parsed, out, err),
        "remote.use" => remote::use_profile(parsed, out, err),
        "remote.remove" => remote::remove(parsed, out, err),
        "mcp.list" => mcp::list(parsed, out, err),
        "mcp.add" => mcp::add(parsed, out, err),
        "mcp.revoke" => mcp::revoke(parsed, out, err),
        _ => {
            let words = parsed.command.words.join(" ");
            crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &Failure::new(Outcome::Refused, format!("ace {words} isn't built yet."))
                    .with_code(ErrorCode::NotFound)
                    .with_hint("See what works today with ace help.")
                    .with_command(parsed.command.id),
            )
        }
    }
}
