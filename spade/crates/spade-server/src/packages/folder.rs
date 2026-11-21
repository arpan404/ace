//! A package read from a folder, as `ace bot test` and the market's signer hand one to Spade's
//! program: its manifest with its contracts' schema files written in (ADR 0200 §7), and its
//! WebAssembly components checked against Spade's world and their own entries (ADR 0203 §5).
//! `spade --code-check <folder>` prints what [`code`] finds, for the signer.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use spade_core::package::code::{self, Import};
use spade_core::package::{Manifest, contract_files, read};

/// `bot.json` in `folder`, as the daemon posts it (its contracts' schemas written in) and read;
/// every problem, each at `bot.json`, otherwise.
pub fn manifest(folder: &Path) -> Result<(Value, Manifest), Vec<String>> {
    let at = |p: String| format!("bot.json: {p}");
    let each = |p: spade_core::rule::Problem| at(p.text);
    let text =
        std::fs::read_to_string(folder.join("bot.json")).map_err(|e| vec![at(e.to_string())])?;
    let recipe: Value = serde_json::from_str(&text).map_err(|e| vec![at(e.to_string())])?;
    let read_file = |path: &str| {
        contract_files::schema_path(path)
            .then(|| std::fs::read_to_string(folder.join(path)).ok())
            .flatten()
    };
    let recipe = contract_files::inline(&recipe, read_file)
        .map_err(|problems| problems.into_iter().map(each).collect::<Vec<_>>())?;
    let manifest = read(&recipe, super::build())
        .map_err(|problems| problems.into_iter().map(each).collect::<Vec<_>>())?;
    Ok((recipe, manifest))
}

/// One component as its binary reads, for the signer's report and the review.
#[derive(Debug, Clone, Serialize)]
pub struct Component {
    pub name: String,
    pub file: String,
    pub sha256: String,
    /// The binary's imports, by the names a manifest lists.
    pub imports: Vec<Import>,
    pub exports: Vec<String>,
    /// The install review's row, from the binary's imports.
    pub review: String,
}

/// Every component `manifest` names, read from `folder` and checked, or every problem. Under
/// `code/`, only a named component, its sources (`code/src/`) and `code/build.json` may be.
pub fn code(folder: &Path, manifest: &Manifest) -> Result<Vec<Component>, Vec<String>> {
    let mut problems = stray(folder, manifest);
    let read = |path: &str| std::fs::read(folder.join(path)).ok();
    let found = match code::check_all(&manifest.code, read) {
        Ok(found) => found,
        Err(found) => {
            problems.extend(spade_core::rule::texts(found));
            Vec::new()
        }
    };
    if !problems.is_empty() {
        return Err(problems);
    }
    Ok(manifest
        .code
        .iter()
        .zip(found)
        .map(|(entry, inspected)| Component {
            name: entry.name.clone(),
            file: entry.file.clone(),
            sha256: read(&entry.file)
                .map(|bytes| hex(&Sha256::digest(&bytes)))
                .unwrap_or_default(),
            review: code::review_row(entry, &inspected, &manifest.effects),
            imports: inspected.imports,
            exports: inspected.exports,
        })
        .collect())
}

/// Files under `code/` that are neither a named component nor its source.
fn stray(folder: &Path, manifest: &Manifest) -> Vec<String> {
    let mut out = Vec::new();
    let mut pending = vec![folder.join("code")];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(relative) = path.strip_prefix(folder) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            if relative == "code/src" || relative.starts_with("code/src/") {
                continue;
            }
            if path.is_dir() {
                pending.push(path);
            } else if relative != "code/build.json"
                && !manifest.code.iter().any(|c| c.file == relative)
            {
                out.push(format!(
                    "{relative} isn't a component bot.json names; code/ holds components, code/src/ and code/build.json"
                ));
            }
        }
    }
    out.sort();
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// What `spade --code-check` prints.
#[derive(Debug, Serialize)]
pub struct CodeReport {
    pub name: Option<String>,
    pub problems: Vec<String>,
    pub components: Vec<Component>,
}

/// The package at `folder`, its manifest and its code checked.
pub fn check(folder: &Path) -> CodeReport {
    match manifest(folder) {
        Err(problems) => CodeReport {
            name: None,
            problems,
            components: Vec::new(),
        },
        Ok((_, manifest)) => {
            let (components, problems) = match code(folder, &manifest) {
                Ok(components) => (components, Vec::new()),
                Err(problems) => (Vec::new(), problems),
            };
            CodeReport {
                name: Some(manifest.name),
                problems,
                components,
            }
        }
    }
}

/// `spade --code-check <folder>`: prints the report as JSON; exits 0 when it passes, 1 when it
/// doesn't, 2 when it couldn't run.
pub fn main(args: &[std::ffi::OsString]) -> std::process::ExitCode {
    let Some(folder) = args.first() else {
        eprintln!("usage: spade --code-check <package folder>");
        return std::process::ExitCode::from(2);
    };
    let report = check(Path::new(folder));
    match serde_json::to_string(&report) {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("the report couldn't be written: {error}");
            return std::process::ExitCode::from(2);
        }
    }
    if report.problems.is_empty() {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}
