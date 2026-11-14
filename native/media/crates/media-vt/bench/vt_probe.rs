// SPDX-License-Identifier: Apache-2.0
//! `vt_probe`: prints the backend's capability list as one JSON line, with
//! how long the bounded trial took.
#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let started = std::time::Instant::now();
    let report = media_vt::probe(&media_vt::ProbeOptions::default());
    let elapsed = started.elapsed().as_secs_f64() * 1e3;
    let capabilities = serde_json::to_string(&report.capabilities)?;
    println!(
        "{{\"bench\":\"probe\",\"backend\":\"vt\",\"elapsedMs\":{elapsed:.1},\"capabilities\":{capabilities}}}"
    );
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("VideoToolbox probe runs on macOS");
}
