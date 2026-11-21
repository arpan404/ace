//! Spade's interface, `spec/code/package.wit` (ADR 0203 §2), against what Spade enforces: a
//! component a toolchain builds for the `bot-tools` world passes the check with the imports the
//! world offers, and links to the worker's host, so every function the interface declares is
//! one the worker defines with the same types.

use spade_core::package::code::{self, Import};
use spade_wasm::BotCode;
use wit_component::{ComponentEncoder, StringEncoding};
use wit_parser::{LiftLowerAbi, ManglingAndAbi, Resolve};

const WIT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/code/package.wit");
const PROGRAM: &str = env!("CARGO_BIN_EXE_spade-wasm");

/// A component for `world` as a toolchain would build it: every import, every export.
fn built_for(world: &str) -> Vec<u8> {
    let mut resolve = Resolve::default();
    let package = resolve
        .push_file(WIT)
        .unwrap_or_else(|e| panic!("Spade's WIT doesn't parse: {e:#}"));
    let world = resolve
        .select_world(&[package], Some(world))
        .unwrap_or_else(|e| panic!("{e:#}"));
    let mut module =
        wit_component::dummy_module(&resolve, world, ManglingAndAbi::Legacy(LiftLowerAbi::Sync));
    wit_component::embed_component_metadata(&mut module, &resolve, world, StringEncoding::UTF8)
        .unwrap_or_else(|e| panic!("{e:#}"));
    ComponentEncoder::default()
        .module(&module)
        .and_then(|encoder| encoder.validate(true).encode())
        .unwrap_or_else(|e| panic!("{e:#}"))
}

#[test]
fn a_component_built_for_bot_tools_reads_as_spades_world() {
    let inspected = code::inspect("code/fares.wasm", &built_for("bot-tools"))
        .unwrap_or_else(|problems| panic!("{problems:?}"));
    assert_eq!(
        inspected.imports,
        vec![Import::Tools, Import::Http, Import::Log, Import::Kv]
    );
    assert_eq!(inspected.exports, vec![code::TOOLBOX.to_owned()]);
}

#[test]
fn a_component_for_a_later_world_has_no_toolbox_for_this_spade() {
    let inspected = code::inspect("code/x.wasm", &built_for("bot-contracts"))
        .unwrap_or_else(|problems| panic!("{problems:?}"));
    assert_eq!(
        inspected.exports,
        vec!["spade:package/contract-handler".to_owned()]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_component_built_for_bot_tools_links_to_the_workers_host() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let code = BotCode::new(
        dir.path(),
        Box::new(|| Ok(tokio::process::Command::new(PROGRAM))),
    );
    code.worker().await.unwrap_or_else(|e| panic!("{e}"));
    let loaded = code.add(&built_for("bot-tools")).await;
    assert!(loaded.is_ok(), "{loaded:?}");
}
