// SPDX-License-Identifier: Apache-2.0
//! Windows (MSVC): this crate's test and example binaries link with
//! `/DEPENDENTLOADFLAG:0x800` like `ace-media` does, so they run with the same
//! System32-only search for their imports.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-tests=/DEPENDENTLOADFLAG:0x800");
        println!("cargo:rustc-link-arg-examples=/DEPENDENTLOADFLAG:0x800");
    }
}
