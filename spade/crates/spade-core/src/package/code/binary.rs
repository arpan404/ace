//! A component's bytes, read with `wasmparser` (ADR 0203 §5): validated with the WebAssembly
//! features Spade's runtime enables, then its outermost imports and exports listed. A core
//! module, a precompiled artefact (Wasmtime's `.cwasm` is a native object file) and anything
//! importing outside Spade's world are refused. The signer runs this through `spade
//! --code-check`, and Spade before it compiles. Pure.

use std::collections::BTreeSet;

use serde::Serialize;
use wasmparser::{
    ComponentExternalKind, ComponentTypeRef, Encoding, Parser, Payload, Validator, WasmFeatures,
};

use super::{Import, MOST_BYTES, outside};

/// What a component's binary imports and exports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Inspected {
    /// Spade's names for what it imports, sorted. `wasi:io/poll`, which the monotonic clock's
    /// interface brings with it, isn't listed.
    pub imports: Vec<Import>,
    /// The interfaces it exports, without their versions (`spade:package/toolbox`).
    pub exports: Vec<String>,
}

/// The WebAssembly features a component may use: WebAssembly 2.0 (bulk memory, reference
/// types, multi-value, SIMD and the rest) and the component model, but no type that needs a
/// garbage collector (`externref`; `funcref` stays). No threads, GC, memory64, exceptions, stack
/// switching or async components. `spade-wasm`'s engine enables exactly these.
pub fn features() -> WasmFeatures {
    let mut features = WasmFeatures::WASM2 | WasmFeatures::COMPONENT_MODEL;
    features.remove(WasmFeatures::GC_TYPES);
    features
}

/// `bytes` read as the component at `path`: what it imports and exports, or every reason it's
/// refused.
pub fn inspect(path: &str, bytes: &[u8]) -> Result<Inspected, Vec<String>> {
    if bytes.len() > MOST_BYTES {
        return Err(vec![format!("{path} is larger than 8 MiB")]);
    }
    if Parser::is_core_wasm(bytes) {
        return Err(vec![format!(
            "{path} is a core WebAssembly module; Spade runs only components built for its world"
        )]);
    }
    if !Parser::is_component(bytes) {
        return Err(vec![format!(
            "{path} isn't a WebAssembly component; precompiled code (.cwasm or any native file) is never accepted, Spade compiles the component itself"
        )]);
    }
    if let Err(error) = Validator::new_with_features(features()).validate_all(bytes) {
        return Err(vec![format!(
            "{path} isn't a valid component for Spade: {}",
            error.message()
        )]);
    }
    let mut problems = Vec::new();
    let mut imports = BTreeSet::new();
    let mut implied = Vec::new();
    let mut exports = BTreeSet::new();
    // Nested modules and components have imports of their own, satisfied inside the component:
    // only the outermost ones reach the host.
    let mut depth = 0usize;
    for payload in Parser::new(0).parse_all(bytes) {
        let payload = match payload {
            Ok(payload) => payload,
            Err(error) => {
                return Err(vec![format!("{path} doesn't read: {}", error.message())]);
            }
        };
        match payload {
            Payload::Version { encoding, .. } if depth == 0 && encoding != Encoding::Component => {
                return Err(vec![format!("{path} isn't a WebAssembly component")]);
            }
            Payload::ModuleSection { .. } | Payload::ComponentSection { .. } => depth += 1,
            Payload::End(_) => depth = depth.saturating_sub(1),
            Payload::ComponentImportSection(reader) if depth == 0 => {
                for import in reader {
                    let import = match import {
                        Ok(import) => import,
                        Err(error) => {
                            return Err(vec![format!("{path} doesn't read: {}", error.message())]);
                        }
                    };
                    let name = import.name.name;
                    // Only interfaces: a bare function or value isn't part of any world Spade has.
                    if !matches!(import.ty, ComponentTypeRef::Instance(_)) {
                        problems.push(format!("{path}: {}", outside(name)));
                        continue;
                    }
                    match imported(name) {
                        Found::Import(import) => {
                            imports.insert(import);
                        }
                        Found::Implied(by) => implied.push((name.to_owned(), by)),
                        Found::Outside => problems.push(format!("{path}: {}", outside(name))),
                    }
                }
            }
            Payload::ComponentExportSection(reader) if depth == 0 => {
                for export in reader {
                    let export = match export {
                        Ok(export) => export,
                        Err(error) => {
                            return Err(vec![format!("{path} doesn't read: {}", error.message())]);
                        }
                    };
                    let name = export.name.name;
                    // Types exported alongside an interface are part of it; anything else is a
                    // Spade interface or refused.
                    if export.kind == ComponentExternalKind::Type {
                        continue;
                    }
                    match exported(name) {
                        Some(interface) if export.kind == ComponentExternalKind::Instance => {
                            exports.insert(interface.to_owned());
                        }
                        _ => problems.push(format!(
                            "{path} exports {name}, which isn't part of Spade's world"
                        )),
                    }
                }
            }
            _ => {}
        }
    }
    for (name, by) in implied {
        if !by.iter().any(|import| imports.contains(import)) {
            problems.push(format!("{path}: {}", outside(&name)));
        }
    }
    if problems.is_empty() {
        Ok(Inspected {
            imports: imports.into_iter().collect(),
            exports: exports.into_iter().collect(),
        })
    } else {
        Err(problems)
    }
}

enum Found {
    Import(Import),
    /// Allowed only beside one of the imports named: `wasi:io/poll` is the monotonic clock's,
    /// `spade:package/types` any Spade interface's.
    Implied(&'static [Import]),
    Outside,
}

/// A binary's import name (`wasi:clocks/wall-clock@0.2.3`) as one of Spade's.
fn imported(name: &str) -> Found {
    let Some((interface, version)) = name.split_once('@') else {
        return Found::Outside;
    };
    let spade = |v: &str| v.starts_with("1.0.") && semver(v);
    let wasi = |v: &str| v.starts_with("0.2.") && semver(v);
    match interface {
        "spade:package/tools" if spade(version) => Found::Import(Import::Tools),
        "spade:package/http" if spade(version) => Found::Import(Import::Http),
        "spade:package/log" if spade(version) => Found::Import(Import::Log),
        "spade:package/kv" if spade(version) => Found::Import(Import::Kv),
        // Shared type definitions, imported by any interface that uses them.
        "spade:package/types" if spade(version) => {
            Found::Implied(&[Import::Tools, Import::Http, Import::Log, Import::Kv])
        }
        "wasi:clocks/wall-clock" if wasi(version) => Found::Import(Import::WallClock),
        "wasi:clocks/monotonic-clock" if wasi(version) => Found::Import(Import::MonotonicClock),
        "wasi:random/random" if wasi(version) => Found::Import(Import::Random),
        "wasi:io/poll" if wasi(version) => Found::Implied(&[Import::MonotonicClock]),
        _ => Found::Outside,
    }
}

/// The interface of one of Spade's exports, any `1.0.x`.
fn exported(name: &str) -> Option<&'static str> {
    let (interface, version) = name.split_once('@')?;
    if !(version.starts_with("1.0.") && semver(version)) {
        return None;
    }
    [
        "spade:package/toolbox",
        "spade:package/contract-handler",
        "spade:package/check",
        "spade:package/card-data",
    ]
    .into_iter()
    .find(|known| *known == interface)
}

/// `major.minor.patch`, digits only.
fn semver(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}
