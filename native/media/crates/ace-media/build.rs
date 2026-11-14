// SPDX-License-Identifier: Apache-2.0
//! Windows (MSVC): the binary's own DLL imports are searched in System32 only
//! (`/DEPENDENTLOADFLAG:0x800`, `LOAD_LIBRARY_SEARCH_SYSTEM32`), never next to a planted
//! copy in the working directory. `media-mf` hardens later loads at run time.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bins=/DEPENDENTLOADFLAG:0x800");
    }
}
