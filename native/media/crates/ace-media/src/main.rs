// SPDX-License-Identifier: Apache-2.0
use std::io::{self, Write};

const VERSION: &str = match option_env!("ACE_MEDIA_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => {
            let _ = writeln!(io::stdout().lock(), "{VERSION}");
            return;
        }
        // One image job, stdin to stdout (ADR 0201): no runtime, no sockets, no secrets.
        Some("--image") => std::process::exit(ace_media::image_cli::run()),
        // The start probe on its own, for `ace doctor`: one JSON line, then exit.
        Some("--probe") => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            let data_dir = match args.as_slice() {
                [flag, dir] if flag == "--data-dir" => Some(std::path::PathBuf::from(dir)),
                _ => None,
            };
            let report = ace_media::probe::report(data_dir.as_deref());
            let _ = writeln!(io::stdout().lock(), "{report}");
            std::process::exit(0);
        }
        _ => {}
    }
    // Before any secret can arrive: no payload in a panic message, no core dump.
    media_noise::install_payload_free_panic_hook();
    ace_media::os::harden();
    std::process::exit(run());
}

fn run() -> i32 {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build();
    match runtime {
        Ok(runtime) => runtime.block_on(ace_media::shell::run(VERSION)),
        Err(_) => 1,
    }
}
