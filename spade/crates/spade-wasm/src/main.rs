//! `spade-wasm`: one bot's code worker (ADR 0203 §3). Started by Spade inside the bot's sandbox;
//! serves Spade's frames on stdin and stdout until Spade closes the pipe. It is also its own
//! sandbox launcher, so its run starts sealed (ADR 0171, amendment 4).

fn main() -> std::process::ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    if let Some(code) = spade_sandbox::linux::dispatch(&args) {
        return code;
    }
    if !args.is_empty() {
        eprintln!("usage: spade-wasm (started by Spade, which speaks to it on stdin and stdout)");
        return std::process::ExitCode::from(2);
    }
    let code = spade_wasm::serve::serve(std::io::stdin().lock(), std::io::stdout());
    std::process::ExitCode::from(u8::try_from(code).unwrap_or(1))
}
