// SPDX-License-Identifier: Apache-2.0
//! `vt_alloc`: Rust heap allocations per frame in steady state, counted on
//! every thread (including VideoToolbox's callback threads, which run this
//! crate's output code). Framework-internal mallocs are outside GlobalAlloc.
#[cfg(target_os = "macos")]
mod common;
#[cfg(target_os = "macos")]
#[path = "vt_alloc_mac.rs"]
mod mac;

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    mac::main()
}
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("VideoToolbox benches run on macOS");
}
