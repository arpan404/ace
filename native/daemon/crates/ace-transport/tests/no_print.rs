// SPDX-License-Identifier: Apache-2.0
//! A library never prints. A blocking write to a stderr nobody drains holds a
//! tokio worker, and a peer can trigger it on every protocol error, which is
//! how one debug `eprintln!` stopped a listener from accepting.

use std::fs;
use std::path::{Path, PathBuf};

/// Every source file the crate ships.
fn sources(dir: &Path, into: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        panic!("{} is not readable", dir.display());
    };
    for entry in entries {
        let Ok(entry) = entry else {
            panic!("{} has an unreadable entry", dir.display());
        };
        let path = entry.path();
        if path.is_dir() {
            sources(&path, into);
        } else if path.extension().is_some_and(|kind| kind == "rs") {
            into.push(path);
        }
    }
}

#[test]
fn the_library_never_prints_to_a_console() {
    // Built from parts so this file does not name them itself.
    let calls: Vec<String> = ["print", "eprint", "println", "eprintln", "dbg"]
        .map(|name| format!("{name}!"))
        .into();
    let mut files = Vec::new();
    sources(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    assert!(!files.is_empty(), "the crate's sources were found");

    for file in files {
        let Ok(text) = fs::read_to_string(&file) else {
            panic!("{} is not readable", file.display());
        };
        for (index, line) in text.lines().enumerate() {
            let code = line.trim_start();
            // A comment may name them; only code may not use them.
            if code.starts_with("//") {
                continue;
            }
            for call in &calls {
                assert!(
                    !line.contains(call.as_str()),
                    "{}:{} prints: {}",
                    file.display(),
                    index + 1,
                    line.trim()
                );
            }
        }
    }
}
