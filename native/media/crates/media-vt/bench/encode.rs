// SPDX-License-Identifier: Apache-2.0
//! `encode --backend vt [--case NAME] [--seconds N]`: hardware encode throughput
//! and paced CPU cost per stream (docs/media/plan.md, "Acceleration acceptance").
#[cfg(target_os = "macos")]
mod common;
#[cfg(target_os = "macos")]
#[path = "encode_mac.rs"]
mod mac;

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    mac::main()
}
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("VideoToolbox benches run on macOS");
}
