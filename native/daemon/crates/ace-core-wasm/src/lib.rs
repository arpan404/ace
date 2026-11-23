// SPDX-License-Identifier: Apache-2.0
//! `ace-core` as WebAssembly for `fake-daemon` in the browser: a thin
//! `wasm-bindgen` binding with no logic of its own (ADR 0223, decided by the
//! orchestrator). One reducer, two loaders: this crate and the napi addon.
//! Built by `scripts/build-core-wasm.ts`. E4 serves the `@ace/core` facade
//! over it.

use wasm_bindgen::prelude::*;

/// E0 stub export proving the binding shape; E4 replaces it with the facade.
#[wasm_bindgen]
pub fn core_crate_name() -> String {
    "ace-core".to_owned()
}
