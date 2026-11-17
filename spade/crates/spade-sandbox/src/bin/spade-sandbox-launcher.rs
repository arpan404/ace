//! The Linux launcher alone (`sandbox-exec`, `sandbox-check`), so this crate's tests run real
//! sandboxes without Spade's server. What ships is `spade`, which starts the same code.

fn main() -> std::process::ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    spade_sandbox::linux::dispatch(&args).unwrap_or(std::process::ExitCode::from(2))
}
