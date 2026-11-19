// SPDX-License-Identifier: Apache-2.0

//! What every file in the bench tree is called and holds.
//!
//! The shapes are deterministic, so the same file count always produces the same checkout, and
//! one source file in fifty carries the literal the content search looks for.

/// File names in one leaf folder.
const NAMES: [&str; 20] = [
    "main", "lib", "mod", "index", "state", "query", "walk", "apply", "render", "socket",
    "history", "models", "views", "util", "error", "config", "types", "server", "client", "worker",
];

/// Crate folder names, so quick-open queries read like the ones a person types.
const CRATES: [&str; 12] = [
    "ace", "files", "srvmain", "editor", "protocol", "daemon", "index", "watch", "search", "io",
    "wire", "cli",
];

/// The modules each crate holds.
const MODULES: [&str; 6] = ["main", "index", "walk", "render", "socket", "types"];

pub fn module_name(module: usize) -> &'static str {
    MODULES[module % MODULES.len()]
}

pub fn crate_name(krate: usize) -> String {
    format!("{}_{krate:03}", CRATES[krate % CRATES.len()])
}

/// A distinct file name inside one folder, the first ones being the plain module names.
pub fn file_name(seed: usize, file: usize, count: usize) -> String {
    let name = NAMES[seed % NAMES.len()];
    let extension = if seed.is_multiple_of(7) { "ts" } else { "rs" };
    if count > NAMES.len() && file >= NAMES.len() {
        format!("{name}_{file}.{extension}")
    } else {
        format!("{name}.{extension}")
    }
}

/// Source-like text of `size` bytes, with the search's literal in roughly every fiftieth file.
pub fn source_text(index: usize, size: usize, marked: bool) -> Vec<u8> {
    let mut text = String::with_capacity(size + 256);
    text.push_str("// SPDX-License-Identifier: Apache-2.0\n");
    text.push_str(&format!(
        "// fixture file {index} for the ace-files checkout bench\n\n"
    ));
    if marked {
        text.push_str("pub const BENCH_SEARCH_TARGET: &str = \"bench_search_marker_token\";\n");
    }
    while text.len() < size {
        text.push_str(
            "    let value = compute(index, input);\n    if value > threshold {\n        record(index, value);\n    }\n",
        );
    }
    text.into_bytes()
}

/// A small installed-package file.
pub fn node_text(package: usize, file: usize) -> Vec<u8> {
    format!(
        "\"use strict\";\n// node_modules fixture {package}/{file}\nconst helper = require(\"./helper\");\n\nmodule.exports = function run(input) {{\n  return helper(input, {file});\n}};\n"
    )
    .into_bytes()
}

/// A small asset file, one of twenty thousand in one folder.
pub fn big_text(file: usize) -> Vec<u8> {
    format!(
        "asset {file}\nname: logo_{file}.svg\nvariants: light dark\n\n{{\"file\":{file},\"scale\":1}}\n"
    )
    .into_bytes()
}
