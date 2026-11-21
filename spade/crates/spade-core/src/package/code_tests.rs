//! A package's code (ADR 0203): the manifest's `code` entries read, and each component's binary
//! checked against Spade's world and against its own entry.

use serde_json::{Value, json};

use super::code::{self, Code, Import};
use super::manifest::Build;

const BUILD: Build<'static> = Build {
    version: "0.0.25",
    task_chars: 4000,
};

/// A component that imports each of `imports` as an (empty) interface and exports `exports`.
fn component(imports: &[&str], exports: &[&str]) -> Vec<u8> {
    let mut text = String::from("(component\n");
    for name in imports {
        text.push_str(&format!("  (import \"{name}\" (instance))\n"));
    }
    for (i, name) in exports.iter().enumerate() {
        text.push_str(&format!(
            "  (instance $e{i})\n  (export \"{name}\" (instance $e{i}))\n"
        ));
    }
    text.push(')');
    wat::parse_str(&text).unwrap_or_else(|e| panic!("{e}\n{text}"))
}

fn toolbox(imports: &[&str]) -> Vec<u8> {
    component(imports, &["spade:package/toolbox@1.0.0"])
}

fn package(code: Value) -> Value {
    json!({
        "format": "spade-bot",
        "version": 3,
        "name": "Fares",
        "task": "Finds cheap fares.",
        "effects": [{"effect": "network", "hosts": ["api.example-fares.com"], "why": "Reads fares."}],
        "code": code,
    })
}

fn entry(imports: &[&str]) -> Value {
    json!({
        "name": "fares",
        "file": "code/fares.wasm",
        "world": "spade:package/bot-tools@1.0.0",
        "imports": imports,
        "why": "Parses fare tables and picks the cheapest.",
    })
}

fn read_code(imports: &[&str]) -> Code {
    let manifest = super::read(&package(json!([entry(imports)])), BUILD)
        .unwrap_or_else(|problems| panic!("{problems:?}"));
    manifest
        .code
        .into_iter()
        .next()
        .unwrap_or_else(|| panic!("no code entry"))
}

fn refused(result: Result<code::Inspected, Vec<String>>, word: &str) {
    match result {
        Ok(found) => panic!("accepted {found:?}, but should be refused for {word:?}"),
        Err(problems) => assert!(
            problems.iter().any(|p| p.contains(word)),
            "{problems:?} says nothing of {word:?}"
        ),
    }
}

#[test]
fn a_valid_component_passes_and_its_review_row_reads_the_binarys_imports() {
    let code = read_code(&["spade:package/tools", "wasi:clocks/wall-clock@0.2"]);
    assert_eq!(code.timeout_s, 30);
    assert_eq!(code.memory_mb, 128);
    let bytes = toolbox(&["spade:package/tools@1.0.0", "wasi:clocks/wall-clock@0.2.3"]);
    let inspected = code::check(&code, &bytes).unwrap_or_else(|p| panic!("{p:?}"));
    assert_eq!(inspected.imports, vec![Import::Tools, Import::WallClock]);
    assert_eq!(inspected.exports, vec!["spade:package/toolbox".to_owned()]);
    let manifest =
        super::read(&package(json!([entry(&[])])), BUILD).unwrap_or_else(|p| panic!("{p:?}"));
    assert_eq!(
        code::review_row(&code, &inspected, &manifest.effects),
        "Runs its own code: fares. It can call Spade's tools as this bot."
    );
}

#[test]
fn the_review_row_names_the_hosts_code_with_http_can_reach() {
    let code = read_code(&["spade:package/http", "spade:package/tools"]);
    let bytes = toolbox(&["spade:package/http@1.0.0", "spade:package/tools@1.0.0"]);
    let inspected = code::check(&code, &bytes).unwrap_or_else(|p| panic!("{p:?}"));
    let manifest = super::read(&package(json!([])), BUILD).unwrap_or_else(|p| panic!("{p:?}"));
    assert_eq!(
        code::review_row(&code, &inspected, &manifest.effects),
        "Runs its own code: fares. It can reach api.example-fares.com and call Spade's tools as this bot."
    );
    assert_eq!(code.effect(), crate::effect::Effect::Network);
}

#[test]
fn a_component_importing_the_file_system_or_sockets_is_refused() {
    let code = read_code(&[]);
    refused(
        code::check(&code, &toolbox(&["wasi:filesystem/types@0.2.0"])),
        "no file system or sockets",
    );
    refused(
        code::check(&code, &toolbox(&["wasi:sockets/tcp@0.2.0"])),
        "no file system or sockets",
    );
    refused(
        code::check(&code, &toolbox(&["wasi:cli/environment@0.2.0"])),
        "no environment",
    );
}

#[test]
fn a_core_module_is_refused() {
    let core = wat::parse_str("(module (func (export \"call\")))").unwrap_or_default();
    refused(
        code::check(&read_code(&[]), &core),
        "core WebAssembly module",
    );
}

#[test]
fn precompiled_code_is_refused() {
    // Wasmtime's `.cwasm` is a native object file: an ELF image, whatever the host.
    let mut cwasm = b"\x7fELF\x02\x01\x01\0".to_vec();
    cwasm.extend_from_slice(&[0; 56]);
    refused(code::check(&read_code(&[]), &cwasm), "never accepted");
    refused(
        code::check(&read_code(&[]), b"not wasm at all"),
        "isn't a WebAssembly component",
    );
}

#[test]
fn a_manifest_list_that_differs_from_the_binarys_imports_is_refused() {
    // The binary reaches for Spade's tools; the manifest says it reaches nothing.
    let code = read_code(&["wasi:clocks/wall-clock@0.2"]);
    let bytes = toolbox(&["spade:package/tools@1.0.0", "wasi:clocks/wall-clock@0.2.0"]);
    refused(
        code::check(&code, &bytes),
        "imports spade:package/tools, wasi:clocks/wall-clock@0.2, but bot.json lists wasi:clocks/wall-clock@0.2",
    );
    // Listing more than the binary imports is refused too: the review shows the binary's list.
    let code = read_code(&["spade:package/tools", "spade:package/log"]);
    refused(
        code::check(&code, &toolbox(&["spade:package/tools@1.0.0"])),
        "must be the same",
    );
}

#[test]
fn the_monotonic_clock_brings_its_poll_interface_and_nothing_else_does() {
    let code = read_code(&["wasi:clocks/monotonic-clock@0.2"]);
    let with_clock = toolbox(&["wasi:io/poll@0.2.0", "wasi:clocks/monotonic-clock@0.2.0"]);
    assert!(code::check(&code, &with_clock).is_ok());
    let alone = toolbox(&["wasi:io/poll@0.2.0"]);
    refused(code::check(&read_code(&[]), &alone), "wasi:io/poll@0.2.0");
}

#[test]
fn an_import_of_another_version_of_spades_world_is_refused() {
    let code = read_code(&["spade:package/tools"]);
    refused(
        code::check(&code, &toolbox(&["spade:package/tools@2.0.0"])),
        "outside Spade's world",
    );
}

#[test]
fn a_component_that_exports_no_toolbox_or_something_else_is_refused() {
    let code = read_code(&[]);
    refused(
        code::check(&code, &component(&[], &[])),
        "doesn't export spade:package/toolbox",
    );
    refused(
        code::check(
            &code,
            &component(
                &[],
                &[
                    "spade:package/toolbox@1.0.0",
                    "wasi:http/incoming-handler@0.2.0",
                ],
            ),
        ),
        "exports wasi:http/incoming-handler@0.2.0",
    );
}

#[test]
fn a_component_over_eight_mib_is_refused_before_it_is_read() {
    let mut big = toolbox(&[]);
    big.resize(code::MOST_BYTES + 1, 0);
    refused(code::check(&read_code(&[]), &big), "larger than 8 MiB");
}

#[test]
fn every_component_named_must_be_in_the_package() {
    let code = read_code(&[]);
    let missing = code::check_all(std::slice::from_ref(&code), |_| None);
    assert!(
        missing.is_err_and(|p| p.iter().any(|p| p.contains("isn't in the package"))),
        "a named component that isn't shipped is refused"
    );
    let present = code::check_all(&[code], |path| {
        (path == "code/fares.wasm").then(|| toolbox(&[]))
    });
    assert!(present.is_ok());
}

#[test]
fn a_calls_bounds_come_from_its_entry() {
    let mut value = entry(&[]);
    value["timeout_s"] = json!(300);
    value["memory_mb"] = json!(512);
    let manifest = super::read(&package(json!([value])), BUILD).unwrap_or_else(|p| panic!("{p:?}"));
    let bounds = manifest.code[0].bounds();
    assert_eq!(bounds.deadline_ms, 300_000);
    assert_eq!(bounds.memory_bytes, 512 * 1024 * 1024);
    assert_eq!(bounds.fuel, 10_000_000_000);
}
