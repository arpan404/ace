// SPDX-License-Identifier: Apache-2.0
//! `vt_still --path gpu`: the current picture of a 1206×2622 HEVC stream to a
//! 1568 px JPEG: VT decode at the destination size, then VT JPEG where its
//! session reports hardware (else one readback and the CPU encoder).
#[cfg(target_os = "macos")]
mod common;
#[cfg(target_os = "macos")]
#[path = "vt_still_mac.rs"]
mod mac;

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    mac::main()
}
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("VideoToolbox benches run on macOS");
}
