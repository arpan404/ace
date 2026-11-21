//! `spade --code-check`'s reading of a package folder (ADR 0203 §5): what the signer runs before
//! it signs a version with code.

use std::path::Path;

use serde_json::json;

use super::folder::check;

fn component(imports: &[&str]) -> Vec<u8> {
    let mut text = String::from("(component\n");
    for name in imports {
        text.push_str(&format!("  (import \"{name}\" (instance))\n"));
    }
    text.push_str(
        "  (instance $box)\n  (export \"spade:package/toolbox@1.0.0\" (instance $box))\n)",
    );
    wat::parse_str(&text).unwrap_or_else(|e| panic!("{e}"))
}

fn write(folder: &Path, path: &str, bytes: &[u8]) {
    let path = folder.join(path);
    std::fs::create_dir_all(path.parent().unwrap_or(folder)).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(path, bytes).unwrap_or_else(|e| panic!("{e}"));
}

fn package(folder: &Path, imports: &[&str]) {
    let bot = json!({
        "format": "spade-bot",
        "version": 3,
        "name": "Fares",
        "task": "Finds cheap fares.",
        "code": [{
            "name": "fares",
            "file": "code/fares.wasm",
            "world": "spade:package/bot-tools@1.0.0",
            "imports": imports,
            "why": "Picks the cheapest fare."
        }]
    });
    write(folder, "bot.json", bot.to_string().as_bytes());
}

#[test]
fn a_package_whose_code_matches_passes_with_the_binarys_review_row() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    package(dir.path(), &["spade:package/tools"]);
    write(
        dir.path(),
        "code/fares.wasm",
        &component(&["spade:package/tools@1.0.0"]),
    );
    write(dir.path(), "code/src/lib.rs", b"// its source");
    let report = check(dir.path());
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    assert_eq!(report.components.len(), 1);
    assert_eq!(
        report.components[0].review,
        "Runs its own code: fares. It can call Spade's tools as this bot."
    );
    assert_eq!(report.components[0].sha256.len(), 64);
}

#[test]
fn a_component_that_imports_the_file_system_fails_the_check() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    package(dir.path(), &[]);
    write(
        dir.path(),
        "code/fares.wasm",
        &component(&["wasi:filesystem/types@0.2.0"]),
    );
    let report = check(dir.path());
    assert!(
        report.problems.iter().any(|p| p.contains("no file system")),
        "{:?}",
        report.problems
    );
    assert!(report.components.is_empty());
}

#[test]
fn precompiled_code_beside_a_component_fails_the_check() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    package(dir.path(), &[]);
    write(dir.path(), "code/fares.wasm", &component(&[]));
    write(dir.path(), "code/fares.cwasm", b"\x7fELF\x02\x01\x01\0");
    let report = check(dir.path());
    assert!(
        report
            .problems
            .iter()
            .any(|p| p.starts_with("code/fares.cwasm")),
        "{:?}",
        report.problems
    );
}

#[test]
fn a_named_component_missing_from_the_folder_fails_the_check() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    package(dir.path(), &[]);
    let report = check(dir.path());
    assert!(
        report
            .problems
            .iter()
            .any(|p| p.contains("isn't in the package")),
        "{:?}",
        report.problems
    );
}
