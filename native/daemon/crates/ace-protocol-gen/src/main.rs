// SPDX-License-Identifier: Apache-2.0
//! Generation-time only: reads the combined `@ace/protocol` JSON Schema that
//! `scripts/generate-rust-protocol.ts` wrote and prints the Rust types to
//! stdout. The script formats the output with the pinned `rustfmt` and
//! writes `ace-protocol/src/generated.rs`, which is committed and never
//! hand-edited.

use std::path::PathBuf;

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let schema_path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: ace-protocol-gen <schema.json>")?;
    let text = std::fs::read_to_string(&schema_path)?;
    let document: serde_json::Value = serde_json::from_str(&text)?;

    // `ThreadStatus` is a union with a `.transform()` branch whose output JSON Schema is
    // unconstrained, so typify would emit a flattened struct that cannot serialize back.
    // Zod's output is `{ state: "unknown", raw }`; the hand-written type says so.
    let mut settings = typify::TypeSpaceSettings::default();
    settings.with_replacement(
        "ThreadStatus",
        "crate::thread_status::ThreadStatus",
        std::iter::empty(),
    );
    let mut space = typify::TypeSpace::new(&settings);
    if let Some(defs) = document.get("$defs").and_then(serde_json::Value::as_object) {
        let mut types = Vec::with_capacity(defs.len());
        for (name, schema) in defs {
            let parsed: schemars::schema::Schema = serde_json::from_value(schema.clone())?;
            types.push((name.clone(), parsed));
        }
        space.add_ref_types(types)?;
    }
    if let Some(roots) = document
        .get("properties")
        .and_then(serde_json::Value::as_object)
    {
        for (_, schema) in roots {
            let parsed: schemars::schema::Schema = serde_json::from_value(schema.clone())?;
            space.add_type(&parsed)?;
        }
    }
    print!("{}", space.to_stream());
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("ace-protocol-gen: {error}");
        std::process::exit(1);
    }
}
